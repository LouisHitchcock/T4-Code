import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppSettings } from "../appSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { SidebarTrigger } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export default function ThreadSidebarToggle({ className }: { className?: string }) {
  const {
    settings: { language },
  } = useAppSettings();
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const toggleLabel = useMemo(() => {
    const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");
    if (language === "fa") {
      return shortcutLabel ? `تغییر نوار کناری (${shortcutLabel})` : "تغییر نوار کناری";
    }
    return shortcutLabel ? `Toggle sidebar (${shortcutLabel})` : "Toggle sidebar";
  }, [keybindings, language]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className={cn(
              "size-8 shrink-0 rounded-md border border-border/70 bg-background/80 shadow-sm backdrop-blur-sm hover:bg-accent/80",
              className,
            )}
            showNativeTitle={false}
          />
        }
      />
      <TooltipPopup side="bottom">{toggleLabel}</TooltipPopup>
    </Tooltip>
  );
}
