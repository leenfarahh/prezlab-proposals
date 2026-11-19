import Link from "next/link";
import { getHubUser } from "@/lib/supabase/server";
import type { Proposal, ViewCount } from "@/lib/types";
import { ProposalGallery } from "@/components/proposal-gallery";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { supabase, isEditor } = await getHubUser();

  const [{ data: proposals, error }, { data: counts }] = await Promise.all([
    supabase
      .from("proposals")
      .select("*")
      .order("proposal_date", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false }),
    supabase.from("proposal_view_counts").select("*"),
  ]);

  if (error) {
    return <p className="alert">Couldn't load proposals: {error.message}</p>;
  }

  const countMap: Record<string, ViewCount> = {};
  (counts as ViewCount[] | null)?.forEach((c) => (countMap[c.proposal_id] = c));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Proposals</h1>
          <p className="muted">{proposals?.length ?? 0} proposals</p>
        </div>
        {isEditor && (
          <Link href="/upload" className="btn btn-primary">
            Upload proposal
          </Link>
        )}
      </div>
      <ProposalGallery proposals={(proposals ?? []) as Proposal[]} counts={countMap} />
    </>
  );
}
