import type { Aspect, ImageEngineId } from '@conveyor/shared';

/** One planned image. */
export interface EngineSlot {
  creativeId: number;
  aspect: Aspect;
  /** Product-wide number per aspect, also the file suffix. */
  slot: number;
  /** What makes this image different from the others in its batch: angle, framing, pose. */
  direction?: string;
}

export interface EngineRequest {
  batchId: number;
  productId: number;
  /** Scratch folder for this batch, under data/workers/. Each task gets a subfolder. */
  workDir: string;
  /** Absolute paths to reference images the engine must match. */
  referencePaths: string[];
  /** Fully filled prompt. The 9:16 rule is already included when relevant. */
  prompt: string;
  slots: EngineSlot[];
  /** `E`: the image being edited and the instruction, added to the task as an edit target. */
  edit?: { path: string; instruction: string } | null;
}

export interface EngineEvents {
  /** Called once per produced image, as soon as its file is complete. Finishing happens here. */
  onImage(slot: EngineSlot, original: Buffer): Promise<void>;
  log(message: string, level?: 'info' | 'warn'): void;
  /** Progress for the UI. */
  progress(done: number, total: number): void;
}

export interface EngineOutcome {
  producedCreativeIds: number[];
  /** Slots still missing when the engine stopped. */
  remaining: EngineSlot[];
  /** Set when the engine gave up early and the rest should go elsewhere. */
  handoff: { reason: string; usageLimit: boolean } | null;
  /** Outside API requests this engine made. Codex makes none. */
  apiRequests: number;
  tasks: number;
  failures: number;
}

export interface ImageEngine {
  id: ImageEngineId;
  available(): Promise<{ ok: boolean; reason: string }>;
  generate(req: EngineRequest, events: EngineEvents): Promise<EngineOutcome>;
}

export type EngineSet = Partial<Record<ImageEngineId, ImageEngine>>;

export class EngineError extends Error {
  constructor(
    message: string,
    readonly engine: ImageEngineId,
    readonly usageLimit = false,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
