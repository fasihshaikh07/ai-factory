# bench/

Benchmarks for the estimates path (see `estimates-design.md`). Read-only: no model calls, no cost.

```
npm run bench -- all                      # both checks; saves to bench/results/ (git-ignored)
npm run bench -- calibrate --home <dir>   # <dir> holds ledger/<runId>/ copied from another machine
npm run bench -- gates
npm run bench -- all --no-save
```
Exit code is 1 if a gate misses a seeded defect, flags clean input, or throws.

## calibrate: does the ledger predict its own cost and time?
Turns each finished step into a record (`calibration/records.ts`), then holds one run out at a time and predicts
its steps from the other runs' steps of the same stage. Reports, per stage and for cost and wall minutes:
- **coverage**: how often the actual falls inside p10-p90 (target 80%);
- **med.err** and **bias**: error of the p50 prediction;
- **confidence**: cold-start (<3 records), partial (<10), calibrated. Cut-offs are assumptions in `stats.ts`.

Needs at least 3 records per stage from *other* runs, so it prints bands but no coverage until more ledgers exist.
Not yet available: per-unit cost (requirements, screens), stack and size band. Those need counted units in the ledger.

## gates: does each gate catch what it should?
`gates/cases.ts` lists seeded defects (`must-fail`) and clean controls (`must-pass`) per gate. The runner calls the
registered gate's predicate directly. Results: caught, missed, ok, false-positive, error, or **pending** when the
gate isn't registered yet (E1-E6 today). Pending never fails the run.

E-gate cases use a provisional `EstimateFixture` (`gates/fixture.ts`). When a gate is built, adapt its cases' `input`
to the real artifact; the mutators (one seeded defect each) carry over.
