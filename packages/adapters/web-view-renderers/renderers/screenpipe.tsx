import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Image as ImageIcon, LoaderCircle, Mic2, Monitor, RefreshCw, Search } from "lucide-react";
import { z } from "zod";
import type { ExactViewRef, JsonValue } from "@info/view";
import type { WebRendererHostV1, WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";

const ExactRefSchema = z.object({ view_id: z.string().min(1), revision: z.number().int().positive() }).strict();
const PeriodSchema = z.object({ start: z.string(), end: z.string(), timezone: z.string().min(1) }).strict();
const TimelineEntrySchema = z.object({
  at: z.string(),
  modality: z.enum(["screen", "audio", "input", "accessibility", "element", "activity"]),
  source: ExactRefSchema,
  label: z.string(),
  text: z.string().optional(),
  app: z.string().optional(),
  window: z.string().optional(),
  url: z.string().optional(),
  focused: z.boolean().optional(),
}).strict();
const FrozenTimelineSchema = z.object({ contract_version: z.literal(1), period: PeriodSchema, entries: z.array(TimelineEntrySchema) }).passthrough();
const TimelineIndexSchema = z.object({
  contract_version: z.literal(1),
  connection_id: z.string().min(1),
  timezone: z.string().min(1),
  modalities: z.array(TimelineEntrySchema.shape.modality),
}).strict();
const AudioViewSchema = z.object({
  contract_version: z.literal(1),
  period: PeriodSchema,
  segments: z.array(z.object({
    at: z.string(), source: ExactRefSchema, text: z.string(), device_type: z.enum(["Input", "Output"]),
    device_name: z.string().optional(), speaker: z.string().optional(), start_seconds: z.number().optional(), end_seconds: z.number().optional(),
  }).strict()),
  transcript: z.string(),
  stats: z.object({ segment_count: z.number().int(), input_segments: z.number().int(), output_segments: z.number().int() }).passthrough(),
}).passthrough();
const QueryResponseSchema = z.object({
  items: z.array(z.object({ key: z.string(), evidence: z.array(ExactRefSchema), value: z.object({
    at: z.string(), modality: TimelineEntrySchema.shape.modality, title: z.string(), text: z.string().optional(), app: z.string().optional(),
    window: z.string().optional(), url: z.string().optional(), focused: z.boolean().optional(),
    device_type: z.string().optional(), device_name: z.string().optional(),
    image: z.object({ kind: z.literal("screenpipe_frame"), frame_id: z.number().int(), view: ExactRefSchema }).strict().optional(),
  }).strict() }).strict()),
  next_cursor: z.string().optional(),
  redacted_boundary: z.boolean(),
}).passthrough();

type Modality = z.infer<typeof TimelineEntrySchema>["modality"];
type TimelineEntry = z.infer<typeof TimelineEntrySchema> & { key: string; image?: ExactViewRef };
const ALL_MODALITIES: Modality[] = ["screen", "audio", "input", "accessibility", "element", "activity"];

export const screenpipeViewRendererFactory = createReactRendererFactory((input, host, signal) => {
  if (input.representation.form !== "inline") throw new TypeError("Screenpipe Renderer requires an inline Representation");
  if (input.envelope.schema.name === "metaflow.screenpipe.audio") return <AudioSurface input={input} />;
  if (input.envelope.schema.name === "metaflow.screenpipe.timeline-index") return <LiveTimeline input={input} host={host} signal={signal} />;
  if (input.envelope.schema.name === "metaflow.screenpipe.timeline") return <FrozenTimeline input={input} />;
  throw new TypeError(`Unsupported Screenpipe View Schema: ${input.envelope.schema.name}`);
});

function LiveTimeline({ input, host, signal }: { input: WebRendererInput; host: WebRendererHostV1; signal: AbortSignal }) {
  if (input.representation.form !== "inline") throw new TypeError("Timeline Index must be inline");
  const index = TimelineIndexSchema.parse(input.representation.value);
  const [date, setDate] = useState(() => localDate(new Date(), index.timezone));
  const [modalities, setModalities] = useState<Modality[]>(index.modalities);
  const [text, setText] = useState("");
  const [hasImage, setHasImage] = useState(false);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string>();
  const requestPage = useCallback(async (append = false) => {
    setStatus("loading"); setFailure(undefined);
    try {
      const period = localDatePeriod(date, index.timezone);
      const response = await host.invokeMethod("entries", {
        parameters: {
          period: { ...period, timezone: index.timezone },
          filters: {
            ...(modalities.length === index.modalities.length ? {} : { modalities }),
            ...(text.trim() ? { text: text.trim() } : {}),
            ...(hasImage ? { has_image: true } : {}),
          },
          order: "descending",
        },
        page: { limit: 50, ...(append && cursor ? { cursor } : {}) },
      }, signal);
      if (!response.ok) throw new Error(response.error.message);
      const page = QueryResponseSchema.parse(response.data);
      const projected = page.items.map(item => ({
        key: item.key, at: item.value.at, modality: item.value.modality, source: item.evidence[0]!, label: item.value.title,
        ...(item.value.text ? { text: item.value.text } : {}), ...(item.value.app ? { app: item.value.app } : {}),
        ...(item.value.window ? { window: item.value.window } : {}), ...(item.value.url ? { url: item.value.url } : {}),
        ...(item.value.focused !== undefined ? { focused: item.value.focused } : {}), ...(item.value.image ? { image: item.value.image.view } : {}),
      }));
      setEntries(current => append ? dedupe([...current, ...projected]) : projected);
      setCursor(page.next_cursor); setStatus("ready");
    } catch (error) {
      if (signal.aborted) return;
      setFailure(error instanceof Error ? error.message : String(error)); setStatus("error");
    }
  }, [cursor, date, hasImage, host, index.modalities, index.timezone, modalities, signal, text]);
  useEffect(() => { void requestPage(false); }, [date, modalities, text, hasImage]);
  useEffect(() => {
    const timer = window.setInterval(() => { void requestPage(false); }, 30_000);
    return () => window.clearInterval(timer);
  }, [requestPage]);
  return <TimelineLayout title="Timeline" date={date} setDate={setDate} timezone={index.timezone} modalities={modalities} setModalities={setModalities} text={text} setText={setText} hasImage={hasImage} setHasImage={setHasImage} refresh={() => void requestPage(false)} status={status} failure={failure} entries={entries} hasMore={Boolean(cursor)} loadMore={() => void requestPage(true)} />;
}

function FrozenTimeline({ input }: { input: WebRendererInput }) {
  if (input.representation.form !== "inline") throw new TypeError("Timeline must be inline");
  const timeline = FrozenTimelineSchema.parse(input.representation.value);
  const all = timeline.entries.map((entry, index) => ({ ...entry, key: `${entry.source.view_id}@${entry.source.revision}:${index}`, ...(entry.modality === "screen" ? { image: entry.source } : {}) }));
  const [modalities, setModalities] = useState<Modality[]>(ALL_MODALITIES);
  const [text, setText] = useState(""); const [hasImage, setHasImage] = useState(false); const [limit, setLimit] = useState(50);
  const filtered = useMemo(() => all.filter(entry => modalities.includes(entry.modality)).filter(entry => !hasImage || entry.image).filter(entry => !text.trim() || JSON.stringify(entry).toLocaleLowerCase().includes(text.trim().toLocaleLowerCase())), [all, hasImage, modalities, text]);
  return <TimelineLayout title="Timeline snapshot" date={localDate(new Date(timeline.period.start), timeline.period.timezone)} timezone={timeline.period.timezone} modalities={modalities} setModalities={setModalities} text={text} setText={setText} hasImage={hasImage} setHasImage={setHasImage} status="ready" entries={filtered.slice(0, limit)} hasMore={limit < filtered.length} loadMore={() => setLimit(value => value + 50)} />;
}

function TimelineLayout(props: { title: string; date: string; setDate?(value: string): void; timezone: string; modalities: Modality[]; setModalities(value: Modality[]): void; text: string; setText(value: string): void; hasImage: boolean; setHasImage(value: boolean): void; refresh?(): void; status: "loading" | "ready" | "error"; failure?: string; entries: TimelineEntry[]; hasMore: boolean; loadMore(): void }) {
  return <div className="screenpipe-renderer" data-renderer="renderer.screenpipe.timeline@1@1">
    <header className="screenpipe-toolbar"><div><strong>{props.title}</strong><span>{props.date} · {props.timezone} · {props.entries.length} loaded</span></div>{props.setDate && <label><CalendarDays size={15} /><input aria-label="Timeline date" type="date" value={props.date} onChange={event => props.setDate?.(event.target.value)} /></label>}<div className="screenpipe-search"><Search size={15} /><input aria-label="Timeline text filter" value={props.text} onChange={event => props.setText(event.target.value)} placeholder="Filter this day" /></div>{props.refresh && <button className="icon-button" type="button" onClick={props.refresh} title="Refresh Timeline" aria-label="Refresh Timeline"><RefreshCw size={16} /></button>}</header>
    <div className="screenpipe-filters">{ALL_MODALITIES.map(modality => <label key={modality}><input type="checkbox" checked={props.modalities.includes(modality)} onChange={() => props.setModalities(props.modalities.includes(modality) ? props.modalities.filter(value => value !== modality) : [...props.modalities, modality])} /><span>{modalityLabel(modality)}</span></label>)}<label><input type="checkbox" checked={props.hasImage} onChange={event => props.setHasImage(event.target.checked)} /><ImageIcon size={14} /><span>Images</span></label></div>
    {props.status === "error" ? <div className="screenpipe-state error">{props.failure}</div> : props.status === "loading" && props.entries.length === 0 ? <div className="screenpipe-state"><LoaderCircle size={20} className="spin" />Loading Timeline</div> : <ol className="screenpipe-stream">{props.entries.map((entry, index) => <TimelineRow key={entry.key} entry={entry} timezone={props.timezone} previous={props.entries[index - 1]} />)}</ol>}
    {props.hasMore && <LoadMore onVisible={props.loadMore} />}
  </div>;
}

function TimelineRow({ entry, previous, timezone }: { entry: TimelineEntry; previous?: TimelineEntry; timezone: string }) {
  const hour = formatHour(entry.at, timezone); const newHour = !previous || formatHour(previous.at, timezone) !== hour;
  return <li>{newHour && <div className="screenpipe-hour"><span>{hour}:00</span></div>}<time>{formatTime(entry.at, timezone)}</time><i className={`modality-${entry.modality}`}>{entry.modality === "screen" ? <Monitor size={13} /> : entry.modality === "audio" ? <Mic2 size={13} /> : null}</i><article><header><strong>{entry.app ?? modalityLabel(entry.modality)}</strong><span>{entry.window ?? modalityLabel(entry.modality)}</span></header>{entry.text ? <p>{entry.text}</p> : <p>{entry.label}</p>}{entry.image && <LazyFrame refValue={entry.image} label={entry.label} />}</article></li>;
}

function LazyFrame({ refValue, label }: { refValue: ExactViewRef; label: string }) {
  const container = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(false); const [width, setWidth] = useState<number>();
  useEffect(() => { const node = container.current; if (!node) return; const observer = new IntersectionObserver(records => { if (records.some(record => record.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "700px" }); observer.observe(node); return () => observer.disconnect(); }, []);
  useEffect(() => { const node = container.current; if (!node || !visible) return; const update = () => setWidth(imageWidth(node.clientWidth, devicePixelRatio)); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [visible]);
  const query = width ? new URLSearchParams({ view_id: refValue.view_id, revision: String(refValue.revision), width: String(width) }) : undefined;
  return <div ref={container} className="screenpipe-frame">{query ? <img src={`/metaflow/v1/assets/screenpipe-frame-thumbnail?${query}`} alt={label} loading="lazy" decoding="async" /> : <ImageIcon size={18} />}</div>;
}

function AudioSurface({ input }: { input: WebRendererInput }) {
  if (input.representation.form !== "inline") throw new TypeError("Audio View must be inline");
  const audio = AudioViewSchema.parse(input.representation.value);
  return <div className="screenpipe-renderer audio-surface"><header className="screenpipe-toolbar"><div><strong>Audio View</strong><span>{audio.segments.length} segments · {audio.period.timezone}</span></div></header><ol className="audio-stream">{audio.segments.map((segment, index) => <li key={`${segment.source.view_id}:${index}`}><time>{formatTime(segment.at, audio.period.timezone)}</time><Mic2 size={15} /><div><header><strong>{segment.device_type === "Input" ? "Microphone" : "System audio"}</strong><span>{segment.device_name ?? segment.speaker}</span></header><p>{segment.text}</p></div></li>)}</ol></div>;
}

function LoadMore({ onVisible }: { onVisible(): void }) { const ref = useRef<HTMLDivElement>(null); useEffect(() => { const node = ref.current; if (!node) return; const observer = new IntersectionObserver(records => { if (records.some(record => record.isIntersecting)) onVisible(); }, { rootMargin: "400px" }); observer.observe(node); return () => observer.disconnect(); }, [onVisible]); return <div ref={ref} className="screenpipe-load"><LoaderCircle size={18} className="spin" /></div>; }
function imageWidth(css: number, ratio: number) { return Math.max(384, Math.min(1920, Math.ceil((css * Math.min(Math.max(ratio, 1), 2)) / 240) * 240)); }
function dedupe(entries: TimelineEntry[]) { return [...new Map(entries.map(entry => [entry.key, entry])).values()]; }
function modalityLabel(value: Modality) { return ({ screen: "Screen", audio: "Audio", input: "Input", accessibility: "Interface", element: "Element", activity: "Activity" } as const)[value]; }
function formatTime(value: string, timezone: string) { return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value)); }
function formatHour(value: string, timezone: string) { return new Intl.DateTimeFormat("en", { hour: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value)); }
function localDate(value: Date, timezone: string) { const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).formatToParts(value); const read = (key: string) => parts.find(part => part.type === key)?.value ?? ""; return `${read("year")}-${read("month")}-${read("day")}`; }
function localDatePeriod(date: string, timezone: string): { start: string; end: string } { const [year, month, day] = date.split("-").map(Number); const at = (offset: number) => zonedMidnight(new Date(Date.UTC(year!, month! - 1, day! + offset)), timezone); return { start: at(0).toISOString(), end: at(1).toISOString() }; }
function zonedMidnight(value: Date, timezone: string) { const wall = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()); let instant = wall; for (let index = 0; index < 4; index += 1) { const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant)); const read = (key: string) => Number(parts.find(part => part.type === key)?.value); const offset = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second")) - instant; const next = wall - offset; if (next === instant) break; instant = next; } return new Date(instant); }
