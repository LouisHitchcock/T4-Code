export const MODEL_SELECTION_SOURCES = ["manual", "project-default", "coordinator"] as const;
export type ModelSelectionSource = (typeof MODEL_SELECTION_SOURCES)[number];
