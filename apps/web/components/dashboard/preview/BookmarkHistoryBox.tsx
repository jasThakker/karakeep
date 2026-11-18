import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/lib/i18n/client";
import useRelativeTime from "@/lib/hooks/relative-time";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight } from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZBookmarkHistoryEntry } from "@karakeep/shared/types/bookmarkHistory";

/**
 * Shows one value of a history entry, clamped to a few lines so long notes or
 * texts don't push the rest of the sidebar away; empty values get a label.
 */
function HistoryValue({
  value,
  className,
}: {
  value: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (value === null) {
    return (
      <span className="italic text-muted-foreground">
        {t("preview.history.empty_value")}
      </span>
    );
  }
  return (
    <span className={cn("line-clamp-3 break-words", className)} title={value}>
      {value}
    </span>
  );
}

/**
 * One change: the field's name and how long ago it changed on the first line,
 * then the old value struck through, an arrow, and the new value.
 */
function HistoryEntryRow({ entry }: { entry: ZBookmarkHistoryEntry }) {
  const { t, i18n } = useTranslation();
  const { fromNow, localCreatedAt } = useRelativeTime(
    entry.createdAt,
    i18n.language,
  );
  return (
    <li className="flex flex-col gap-1" data-history-row={entry.id}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">
          {t(`preview.history.fields.${entry.field}`)}
        </span>
        <time
          className="shrink-0 text-muted-foreground"
          dateTime={entry.createdAt.toISOString()}
          title={localCreatedAt}
        >
          {fromNow}
        </time>
      </div>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
        <HistoryValue
          value={entry.oldValue}
          className="text-muted-foreground line-through"
        />
        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <HistoryValue value={entry.newValue} />
      </div>
    </li>
  );
}

/**
 * The bookmark's change history in the preview sidebar, newest first, as a
 * collapsible section like the highlights. Renders nothing until the bookmark
 * has history; the server leaves out entries the viewer isn't allowed to see.
 */
export default function BookmarkHistoryBox({
  bookmarkId,
}: {
  bookmarkId: string;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const { data, isPending } = useQuery(
    api.bookmarks.getBookmarkHistory.queryOptions({ bookmarkId }),
  );

  if (isPending || !data || data.history.length === 0) {
    return null;
  }

  return (
    <>
      <Separator />
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11">
          <span className="flex items-center gap-2">
            {t("preview.history.title")}
            <span className="font-normal tabular-nums">
              {data.history.length}
            </span>
          </span>
          <ChevronRight
            className={cn("size-4 transition-transform", isOpen && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="flex flex-col gap-3 py-3">
            {data.history.map((entry) => (
              <HistoryEntryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
