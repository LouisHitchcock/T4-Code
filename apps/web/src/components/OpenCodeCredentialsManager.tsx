import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, memo } from "react";
import { Trash2Icon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, KeyIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { serverOpenCodeStateQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { useAppSettings } from "~/appSettings";

export const OpenCodeCredentialsManager = memo(function OpenCodeCredentialsManager() {
  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const [providerToAdd, setProviderToAdd] = useState("");
  const [apiKeyToAdd, setApiKeyToAdd] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [openRouterKeyToAdd, setOpenRouterKeyToAdd] = useState("");
  const [isAddingOpenRouter, setIsAddingOpenRouter] = useState(false);
  const [openRouterAddError, setOpenRouterAddError] = useState<string | null>(null);

  const openCodeStateQuery = useQuery(
    serverOpenCodeStateQueryOptions({
      binaryPath: settings.opencodeBinaryPath.trim() || undefined,
      refreshModels: false,
    }),
  );

  const credentials = useMemo(
    () =>
      openCodeStateQuery.data?.status === "available" ? openCodeStateQuery.data.credentials : [],
    [openCodeStateQuery.data],
  );

  const models = useMemo(
    () => (openCodeStateQuery.data?.status === "available" ? openCodeStateQuery.data.models : []),
    [openCodeStateQuery.data],
  );

  const uniqueProviderIds = useMemo(() => {
    const seen = new Set<string>();
    for (const model of models) {
      seen.add(model.providerId);
    }
    return [...seen].toSorted();
  }, [models]);

  const hasOpenRouterCredential = useMemo(
    () => credentials.some((c) => c.name.toLowerCase() === "openrouter"),
    [credentials],
  );

  const binaryPath = settings.opencodeBinaryPath?.trim() || undefined;

  const handleAddOpenRouterKey = async () => {
    if (!openRouterKeyToAdd.trim()) return;
    setIsAddingOpenRouter(true);
    setOpenRouterAddError(null);
    try {
      const api = ensureNativeApi();
      const result = await api.server.addOpenCodeCredential({
        provider: "openrouter",
        apiKey: openRouterKeyToAdd.trim(),
        binaryPath,
      });
      if (!result.success) {
        setOpenRouterAddError(result.message ?? "Failed to add OpenRouter key");
      } else {
        setOpenRouterKeyToAdd("");
        await queryClient.invalidateQueries({
          queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: false }),
        });
        await queryClient.invalidateQueries({
          queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: true }),
        });
      }
    } catch (err) {
      setOpenRouterAddError(err instanceof Error ? err.message : "Failed to add OpenRouter key");
    } finally {
      setIsAddingOpenRouter(false);
    }
  };

  const handleAddCredential = async () => {
    if (!providerToAdd.trim() || !apiKeyToAdd.trim()) return;
    setIsAdding(true);
    setAddError(null);
    try {
      const api = ensureNativeApi();
      const result = await api.server.addOpenCodeCredential({
        provider: providerToAdd.trim(),
        apiKey: apiKeyToAdd.trim(),
        binaryPath,
      });
      if (!result.success) {
        setAddError(result.message ?? "Failed to add credential");
      } else {
        setProviderToAdd("");
        setApiKeyToAdd("");
        await queryClient.invalidateQueries({
          queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: false }),
        });
        await queryClient.invalidateQueries({
          queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: true }),
        });
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add credential");
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveCredential = async (provider: string) => {
    try {
      const api = ensureNativeApi();
      await api.server.removeOpenCodeCredential({ provider, binaryPath });
      await queryClient.invalidateQueries({
        queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: false }),
      });
      await queryClient.invalidateQueries({
        queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: true }),
      });
    } catch (err) {
      console.error("Failed to remove credential:", err);
    }
  };

  const handleRefreshModels = async () => {
    await queryClient.invalidateQueries({
      queryKey: serverQueryKeys.openCodeState({ binaryPath, refreshModels: true }),
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3 bg-muted/30">
        <div className="flex items-center gap-2 mb-2">
          <KeyIcon className="size-4 text-muted-foreground" />
          <h3 className="text-xs font-medium text-foreground">OpenRouter API Key</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Required for providers like MiniMax that route through OpenRouter. Get your key from{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            openrouter.ai/keys
          </a>
        </p>
        {hasOpenRouterCredential ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-green-600 dark:text-green-400">
              OpenRouter key configured
            </span>
            <Button size="xs" variant="ghost" onClick={() => handleRemoveCredential("openrouter")}>
              <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              placeholder="sk-or-v1-..."
              type="password"
              value={openRouterKeyToAdd}
              onChange={(e) => setOpenRouterKeyToAdd(e.target.value)}
              className="text-xs"
              dir="ltr"
              autoComplete="new-password"
            />
            {openRouterAddError && <p className="text-xs text-destructive">{openRouterAddError}</p>}
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddOpenRouterKey}
              disabled={isAddingOpenRouter || !openRouterKeyToAdd.trim()}
              className="w-full"
            >
              {isAddingOpenRouter ? (
                <LoaderCircleIcon className="size-3 animate-spin mr-1" />
              ) : (
                <PlusIcon className="size-3 mr-1" />
              )}
              Add OpenRouter Key
            </Button>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-foreground mb-2">Authenticated Providers</h3>
        {openCodeStateQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            Loading...
          </div>
        ) : credentials.filter((c) => c.name.toLowerCase() !== "openrouter").length === 0 ? (
          <p className="text-xs text-muted-foreground">No providers authenticated.</p>
        ) : (
          <div className="space-y-1">
            {credentials
              .filter((c) => c.name.toLowerCase() !== "openrouter")
              .map((cred) => (
                <div
                  key={`${cred.name}-${cred.authType}`}
                  className="flex items-center justify-between rounded bg-muted/50 px-2 py-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{cred.name}</span>
                    <span className="text-xs text-muted-foreground">({cred.authType})</span>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => handleRemoveCredential(cred.name)}
                  >
                    <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-foreground mb-2">Add Provider</h3>
        <div className="space-y-2">
          <Input
            placeholder="Provider (e.g., anthropic, openai, deepseek, minimax)"
            value={providerToAdd}
            onChange={(e) => setProviderToAdd(e.target.value)}
            className="text-xs"
            dir="ltr"
          />
          <Input
            placeholder="API Key"
            type="password"
            value={apiKeyToAdd}
            onChange={(e) => setApiKeyToAdd(e.target.value)}
            className="text-xs"
            dir="ltr"
            autoComplete="new-password"
          />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <Button
            size="sm"
            variant="outline"
            onClick={handleAddCredential}
            disabled={isAdding || !providerToAdd.trim() || !apiKeyToAdd.trim()}
            className="w-full"
          >
            {isAdding ? (
              <LoaderCircleIcon className="size-3 animate-spin mr-1" />
            ) : (
              <PlusIcon className="size-3 mr-1" />
            )}
            Add Credential
          </Button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-foreground">
            Available Models ({uniqueProviderIds.length} providers, {models.length} models)
          </h3>
          <Button size="xs" variant="ghost" onClick={handleRefreshModels}>
            <RefreshCwIcon className="size-3" />
          </Button>
        </div>
        {models.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No models available. Add a provider credential first.
          </p>
        ) : (
          <div className="max-h-40 overflow-y-auto rounded bg-muted/50 p-2">
            {uniqueProviderIds.map((providerId) => (
              <div key={providerId} className="mb-2">
                <div className="text-xs font-medium text-foreground mb-1">{providerId}</div>
                <div className="pl-2 space-y-0.5">
                  {models
                    .filter((m) => m.providerId === providerId)
                    .map((model) => (
                      <div key={model.slug} className="text-xs text-muted-foreground">
                        {model.modelId}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
