import type { FastifyReply } from 'fastify';

/** Sends the API's standard error envelope. */
export function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

export function notFound(reply: FastifyReply, message: string): FastifyReply {
  return fail(reply, 404, 'not_found', message);
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return fail(reply, 400, 'bad_request', message);
}
