"use client";

import { useActionState, useEffect, useRef } from "react";
import { clientPath } from "@/lib/links";
import { takeDownLink, type ActionState } from "./actions";

/** Retires a leaked link. The proposal itself stays in the hub. */
export function TakedownButton({ id, linkName }: { id: string; linkName: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(takeDownLink, null);

  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);

  return (
    <>
      <button type="button" className="btn btn-danger-solid" onClick={() => dialog.current?.showModal()}>
        Retire link
      </button>

      <dialog ref={dialog} className="dialog" aria-labelledby="takedown-title">
        <form action={action} className="stack">
          <input type="hidden" name="id" value={id} />
          <h2 id="takedown-title">Retire {clientPath(linkName)}?</h2>
          <ul className="small plain-list">
            <li>Nothing is deleted. The proposal, its files, stats and history stay in the hub.</li>
            <li>The link stops working now, for everyone it was sent or forwarded to.</li>
            <li>The password is cleared, so anyone who already opened it is signed out.</li>
            <li>This link name can't be used again. To share again, set a new link name and password.</li>
            <li>Copies someone already saved can't be recalled.</li>
          </ul>
          <label className="field">
            <span>Reason (optional, saved in the history)</span>
            <input name="reason" maxLength={300} placeholder="e.g. Link was posted publicly" />
          </label>
          {state && !state.ok && <p className="alert">{state.message}</p>}
          <div className="row">
            <button className="btn btn-danger-solid" disabled={pending}>
              {pending ? "Retiring…" : "Retire link now"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
