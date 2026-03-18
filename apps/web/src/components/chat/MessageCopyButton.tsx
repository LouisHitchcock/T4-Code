import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { useAppSettings } from "~/appSettings";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const {
    settings: { language },
  } = useAppSettings();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const title = language === "fa" ? "کپی پیام" : "Copy message";

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => copyToClipboard(text)}
      title={title}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
