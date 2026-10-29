/** Shared access to the generated test statements (seeded once per process). */
import { buildScenarios, finStatementSource, type Scenario, type StatementSource } from '../../src/testing/statements/index.js';

let sourcePromise: Promise<StatementSource> | undefined;
let scenariosPromise: Promise<Scenario[]> | undefined;

export function getStatementSource(): Promise<StatementSource> {
  if (!sourcePromise) sourcePromise = finStatementSource();
  return sourcePromise;
}

export function getScenarios(): Promise<Scenario[]> {
  if (!scenariosPromise) scenariosPromise = getStatementSource().then(buildScenarios);
  return scenariosPromise;
}

export async function getScenario(id: string): Promise<Scenario> {
  const sc = (await getScenarios()).find(s => s.id === id);
  if (!sc) throw new Error(`no scenario ${id}`);
  return sc;
}

export async function getFile(scenarioId: string, namePart: string) {
  const sc = await getScenario(scenarioId);
  const f = sc.files.find(f => f.name.includes(namePart));
  if (!f) throw new Error(`no file matching "${namePart}" in ${scenarioId}: ${sc.files.map(f => f.name).join(', ')}`);
  return f;
}
