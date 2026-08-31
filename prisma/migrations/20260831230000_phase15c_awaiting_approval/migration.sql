-- PHASE 15c STAGE 2 — work pauses for a driver's decision.
--
-- A revised estimate that exceeds what the driver approved by more than the
-- configured tolerance needs a NEW approval, and the brief is emphatic about
-- what happens meanwhile: work PAUSES. It does not continue optimistically
-- while somebody hopes the driver says yes.
--
-- Modelled as a JOB STATUS rather than a boolean on the job, because the
-- technician's status ladder (src/domain/jobLadder.ts) advances by rank
-- between known statuses — and AWAITING_APPROVAL is deliberately not one of
-- them. A paused job is therefore one the ladder cannot move at all, which
-- makes the pause structural rather than a check somebody has to remember to
-- write. Resuming is the approval's job, not the technician's.
--
-- Added next to AWAITING_DESTINATION, the other "waiting on somebody outside
-- this system" state, rather than at the end of the enum.

ALTER TYPE "JobStatus" ADD VALUE 'AWAITING_APPROVAL' BEFORE 'AWAITING_DESTINATION';
