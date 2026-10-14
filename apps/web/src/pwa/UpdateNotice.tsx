import { useUpdateReady } from './updates.ts';

/**
 * A newer build has taken over this page (OPS-04): say so, and let her reload when it suits
 * her. Quiet, at the top, and never a reload by itself, for the reason in `updates.ts`.
 */
export function UpdateNotice({
  reload = () => window.location.reload(),
}: {
  readonly reload?: () => void;
}) {
  if (!useUpdateReady()) return null;
  return (
    <p className="notice update" role="status">
      Dinora has been updated.{' '}
      <button type="button" className="quiet" onClick={reload}>
        Reload
      </button>
    </p>
  );
}
