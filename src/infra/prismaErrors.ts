// WHAT A DATABASE ERROR MEANS, named once.
//
// `P2002` is Prisma's code for a unique-constraint violation, and this project
// leans on that specific error as a CONTROL-FLOW SIGNAL rather than a failure:
// several places deliberately let two writers race and use the constraint to
// decide which one won. `src/queues/idempotent.ts` does it for exactly-once
// queue processing; `src/commit/decisionRecords.ts` does it for plan
// selection.
//
// The predicate lives here rather than in either of them because a second
// literal `'P2002'` somewhere is a second definition of "already exists", and
// those are the kind of thing that quietly disagree. It is in /src/infra
// because both callers are above that layer — a commit module importing from
// a queue module would be the wrong way round.

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
