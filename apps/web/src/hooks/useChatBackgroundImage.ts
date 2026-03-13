import { useEffect, useState } from "react";

import { loadChatBackgroundBlob } from "../lib/chatBackgroundStorage";

interface ChatBackgroundImageState {
  url: string | null;
  loading: boolean;
}

export function useChatBackgroundImage(
  assetId: string | null | undefined,
  legacyDataUrl: string | null | undefined,
): ChatBackgroundImageState {
  const [state, setState] = useState<ChatBackgroundImageState>(() => ({
    url: legacyDataUrl?.trim() || null,
    loading: false,
  }));

  useEffect(() => {
    const trimmedAssetId = assetId?.trim() || null;
    const trimmedLegacyDataUrl = legacyDataUrl?.trim() || null;

    if (!trimmedAssetId) {
      setState({ url: trimmedLegacyDataUrl, loading: false });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState((existing) => ({ url: existing.url, loading: true }));

    void loadChatBackgroundBlob(trimmedAssetId)
      .then((blob) => {
        if (cancelled) {
          return;
        }

        if (!blob) {
          setState({ url: trimmedLegacyDataUrl, loading: false });
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ url: trimmedLegacyDataUrl, loading: false });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assetId, legacyDataUrl]);

  return state;
}
