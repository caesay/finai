/**
 * Circular progress indicator.
 *
 * Determinate when the caller knows how far along the work is, indeterminate
 * otherwise. Most of what this app waits on — a Codex turn, a bank feed, a
 * commit — reports nothing until it is finished, so indeterminate is the honest
 * default; a bar that invents a percentage is worse than one that admits it
 * does not know.
 */
interface SpinnerProps {
  size?: number;
  /**
   * Fraction complete, 0 to 1. Omitted spins indefinitely.
   */
  value?: number;
  /** Announced to screen readers, since the arc itself says nothing. */
  label?: string;
}

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function Spinner({ size = 14, value, label = 'Working' }: SpinnerProps) {
  const determinate = value !== undefined;
  const clamped = determinate ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <span
      className={`spinner ${determinate ? 'spinner--determinate' : 'spinner--indeterminate'}`}
      role={determinate ? 'progressbar' : 'status'}
      aria-label={label}
      {...(determinate
        ? { 'aria-valuenow': Math.round(clamped * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }
        : {})}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle className="spinner__track" cx="12" cy="12" r={RADIUS} />
        <circle
          className="spinner__arc"
          cx="12"
          cy="12"
          r={RADIUS}
          {...(determinate
            ? {
                strokeDasharray: CIRCUMFERENCE,
                strokeDashoffset: CIRCUMFERENCE * (1 - clamped),
              }
            : {})}
        />
      </svg>
    </span>
  );
}

/** A spinner with a line of text beside it, for whole-panel waits. */
export function LoadingLine({ children, value }: { children: React.ReactNode; value?: number }) {
  return (
    <p className="dim loading-line">
      <Spinner value={value} />
      <span>{children}</span>
    </p>
  );
}
