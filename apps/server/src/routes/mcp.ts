import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';

import { registerTools } from '../mcp/tools.js';

/**
 * The MCP endpoint the assistant talks to.
 *
 * It is hosted by this server rather than spawned as a separate process, so the
 * tools run against the same repositories every route uses — no second database
 * handle, no drift.
 *
 * Stateless: a transport and server are built per request and torn down after
 * it. Sessions would buy resumable streams, which nothing here needs, at the
 * cost of state to expire and leak.
 *
 * This sits behind the same front door as the rest of the API and has no auth
 * of its own, which is the app's existing bargain — anything that can reach the
 * front end is authorized.
 */
export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    const server = new McpServer(
      { name: 'finai', version: app.config.version },
      {
        instructions:
          'Tools for a personal finance tracker. Money is always an integer count of minor units (pence or cents) and a negative amount means money left the account.',
      },
    );

    registerTools(server, {
      repositories: app.repositories,
      config: app.config,
      codex: app.codex,
      log: { warn: (context, message) => app.log.warn(context, message) },
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    // The transport writes the response itself, headers and all.
    reply.hijack();

    // Fastify has already parsed the body; handing it over stops the transport
    // waiting on a stream that has been consumed.
    await transport.handleRequest(request.raw, reply.raw, request.body);

    return reply;
  });
}
