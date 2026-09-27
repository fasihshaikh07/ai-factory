// Test helper: build a VSTest TRX document.
export function trx(results: { name: string; outcome: string; message?: string; stack?: string; cls?: string }[], project = "Shop.Tests", ns = "Shop.Tests"): string {
  const defs = results.map((r, i) => `<UnitTest name="${r.name}" storage="/src/tests/${project}/bin/Debug/net8.0/${project}.dll" id="id-${i}">
      <TestMethod codeBase="x" className="${ns}.${r.cls ?? "CheckoutTests"}" name="${r.name}" /></UnitTest>`).join("\n");
  const res = results.map((r, i) => `<UnitTestResult testId="id-${i}" testName="${r.name}" outcome="${r.outcome}" duration="00:00:00.0120000">
      ${r.message ? `<Output><ErrorInfo><Message>${r.message}</Message><StackTrace>${r.stack ?? ""}</StackTrace></ErrorInfo></Output>` : ""}
    </UnitTestResult>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Times start="2026-09-27T10:00:00" />
  <Results>${res}</Results>
  <TestDefinitions>${defs}</TestDefinitions>
  <ResultSummary outcome="Failed"><Counters total="${results.length}" executed="${results.length}" passed="0" failed="0" /></ResultSummary>
</TestRun>`;
}

