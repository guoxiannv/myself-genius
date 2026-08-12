export function canRunRepair(repairTurns, completedAttempts) {
  if (!Number.isInteger(completedAttempts) || completedAttempts < 0) throw new Error(`invalid completed repair count: ${completedAttempts}`);
  if (!Number.isInteger(repairTurns) || repairTurns < 0) throw new Error(`invalid repairTurns policy: ${repairTurns}`);
  return completedAttempts < repairTurns;
}

export function repairArtifactName(stem, attempt, extension) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid repair attempt: ${attempt}`);
  return `${stem}${attempt === 1 ? '' : `-${attempt}`}${extension}`;
}
