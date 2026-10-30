import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { casesApi, type DocumentPublicationResult } from "@/api/cases";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Slashbin (EM#642): publish and withdraw controls for a protected Case's documents.
// Who may publish is the server gate's call alone; a refusal is shown as the gate words it.

export interface PublicationPanelDocument {
  key: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number | null;
}

type Pending = { action: "publish" | "withdraw"; key: string };

export function CasePublicationPanel({
  caseIdentifier,
  companyId,
  documents,
}: {
  caseIdentifier: string;
  companyId: string;
  documents: PublicationPanelDocument[];
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The published-documents read lists only what is published, so a withdrawal is
  // known here only from this session's own withdraw responses.
  const [withdrawn, setWithdrawn] = useState<Set<string>>(new Set());

  const publishedQuery = useQuery({
    queryKey: queryKeys.cases.published(companyId),
    queryFn: () => casesApi.listPublished(companyId),
  });
  const published = new Map(
    (publishedQuery.data?.documents ?? [])
      .filter((row) => row.caseIdentifier === caseIdentifier)
      .map((row) => [row.key, row]),
  );

  const mutation = useMutation({
    mutationFn: ({ action, key, baseRevisionId, changeSummary }: Pending & { baseRevisionId: string | null; changeSummary: string }) =>
      action === "publish"
        ? casesApi.publishDocument(caseIdentifier, key, { baseRevisionId: baseRevisionId!, changeSummary })
        : casesApi.withdrawDocument(caseIdentifier, key, { changeSummary }),
    onSuccess: (result: DocumentPublicationResult) => {
      setWithdrawn((prev) => {
        const next = new Set(prev);
        if (result.state === "withdrawn") next.add(result.key);
        else next.delete(result.key);
        return next;
      });
      setPending(null);
      setSummary("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.cases.published(companyId) });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Request failed");
    },
  });

  if (documents.length === 0) return null;

  const open = (action: Pending["action"], key: string) => {
    setPending({ action, key });
    setSummary("");
    setError(null);
  };

  return (
    <section className="space-y-2" data-testid="case-publication-panel">
      <h2 className="text-sm font-semibold">Publication</h2>
      {documents.map((doc) => {
        const row = published.get(doc.key);
        const isPending = pending?.key === doc.key;
        const stateLabel = row
          ? `Published (rev ${row.revisionNumber})`
          : withdrawn.has(doc.key)
            ? "Withdrawn"
            : "Draft";
        return (
          <Card key={doc.key} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{doc.key}</span>
              <Badge variant="secondary" data-testid={`publication-state-${doc.key}`}>{stateLabel}</Badge>
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  disabled={!doc.latestRevisionId || mutation.isPending}
                  onClick={() => open("publish", doc.key)}
                >
                  Publish this revision
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => open("withdraw", doc.key)}
                >
                  Withdraw
                </Button>
              </div>
            </div>
            {isPending ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {pending.action === "publish"
                    ? `Publish revision ${doc.latestRevisionNumber ?? ""} of ${doc.key}?`
                    : `Withdraw ${doc.key} from the published set?`}
                </p>
                <Input
                  aria-label="Publication change summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  placeholder="Why you are doing this (recorded in the activity log)"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!summary.trim() || mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        ...pending,
                        baseRevisionId: doc.latestRevisionId,
                        changeSummary: summary.trim(),
                      })
                    }
                  >
                    {pending.action === "publish" ? "Confirm publish" : "Confirm withdraw"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setPending(null); setError(null); }}>
                    Cancel
                  </Button>
                </div>
                {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
              </div>
            ) : null}
          </Card>
        );
      })}
    </section>
  );
}
