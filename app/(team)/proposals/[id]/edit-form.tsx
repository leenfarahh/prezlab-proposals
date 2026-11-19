"use client";

import { useActionState } from "react";
import { STATUSES, type Proposal } from "@/lib/types";
import { updateProposal, type ActionState } from "./actions";

export function EditForm({ proposal }: { proposal: Proposal }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateProposal, null);

  return (
    <form action={action} className="stack">
      <input type="hidden" name="id" value={proposal.id} />

      <label className="field">
        <span>Title</span>
        <input name="title" defaultValue={proposal.title} required />
      </label>

      <label className="field">
        <span>Client</span>
        <input name="client" defaultValue={proposal.client ?? ""} />
      </label>

      <div className="row two">
        <label className="field">
          <span>Status</span>
          <select name="status" defaultValue={proposal.status}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Date</span>
          <input type="date" name="proposal_date" defaultValue={proposal.proposal_date ?? ""} />
        </label>
      </div>

      <label className="field">
        <span>Tags (comma separated)</span>
        <input name="tags" defaultValue={proposal.tags.join(", ")} />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea name="description" rows={3} defaultValue={proposal.description ?? ""} />
      </label>

      <div className="row">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save details"}
        </button>
        {state && <span className={state.ok ? "success-inline" : "alert-inline"}>{state.message}</span>}
      </div>
    </form>
  );
}
