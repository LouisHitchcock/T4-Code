export function normalizeDesktopSecretValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldPersistDesktopSecrets(args: {
  platform: NodeJS.Platform;
  encryptionAvailable: boolean;
  selectedStorageBackend?: string | null;
}): boolean {
  if (!args.encryptionAvailable) {
    return false;
  }

  if (args.platform !== "linux") {
    return true;
  }

  return args.selectedStorageBackend !== "basic_text";
}
