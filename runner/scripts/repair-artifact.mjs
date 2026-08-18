export function repairArtifactName(stem, attempt, extension) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid repair attempt: ${attempt}`);
  return `${stem}${attempt === 1 ? '' : `-${attempt}`}${extension}`;
}
