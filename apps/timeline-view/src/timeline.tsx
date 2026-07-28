import {
  Activity,
  AppWindow,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDot,
  Focus,
  Image as ImageIcon,
  Keyboard,
  LoaderCircle,
  Menu,
  Mic2,
  Monitor,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  TimelineClient,
  TimelineClientError,
  localDatePeriod,
  thumbnailRequestWidth,
  todayInputValue,
  type ExactRef,
  type TimelineEntry,
  type TimelineFilters,
} from "./api.js";

const client = new TimelineClient();
const ALL_MODALITIES: TimelineFilters["modalities"] = ["screen", "audio", "input", "accessibility", "element", "activity"];

type Status = "loading" | "ready" | "empty" | "error";

export function TimelineApp() {
  const [date, setDate] = useState(todayInputValue);
  const [filters, setFilters] = useState<TimelineFilters>({ modalities: [...ALL_MODALITIES], hasImage: false, focused: false });
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [subject, setSubject] = useState<ExactRef>();
  const [connection, setConnection] = useState<{ id: string; generation: number }>();
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<{ code: string; message: string }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newRecords, setNewRecords] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const firstKeyRef = useRef<string | undefined>(undefined);

  const loadPage = useCallback(async (mode: "replace" | "append", cursor?: string, signal?: AbortSignal) => {
    if (!subject) return;
    if (mode === "append") setLoadingMore(true);
    else {
      setStatus("loading");
      setError(undefined);
    }
    try {
      const page = await client.page({ subject, date, timezone, filters, cursor, signal });
      setEntries(current => mode === "append" ? dedupe([...current, ...page.entries]) : page.entries);
      setNextCursor(page.nextCursor);
      if (mode === "replace") {
        firstKeyRef.current = page.entries[0]?.key;
        setNewRecords(false);
        setStatus(page.entries.length === 0 && !page.nextCursor ? "empty" : "ready");
      }
    } catch (cause) {
      if (signal?.aborted) return;
      const failure = failureFrom(cause);
      setError(failure);
      if (mode === "replace") setStatus("error");
    } finally {
      if (mode === "append") setLoadingMore(false);
    }
  }, [date, filters, subject, timezone]);

  useEffect(() => {
    const controller = new AbortController();
    void client.info(controller.signal).then(async info => {
      setTimezone(info.timezone);
      setDate(todayInputValue(new Date(), info.timezone));
      setConnection({ id: info.connection_id, generation: info.generation });
      setSubject(await client.resolveLatest(info.index_view_id, controller.signal));
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(failureFrom(cause));
      setStatus("error");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!subject) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void loadPage("replace", undefined, controller.signal);
    return () => controller.abort();
  }, [loadPage, subject]);

  const probeForNewRecords = useCallback(async () => {
    if (!subject || date !== todayInputValue(new Date(), timezone)) return;
    setRefreshing(true);
    const controller = new AbortController();
    try {
      const page = await client.page({ subject, date, timezone, filters, limit: 1, signal: controller.signal });
      if (page.entries[0]?.key && page.entries[0].key !== firstKeyRef.current) setNewRecords(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureFrom(cause));
    } finally {
      setRefreshing(false);
    }
  }, [date, filters, subject, timezone]);

  const refreshSource = useCallback(async () => {
    if (!connection || !subject || date !== todayInputValue(new Date(), timezone)) return;
    setRefreshing(true);
    const controller = new AbortController();
    try {
      await client.pull(connection.id, connection.generation, controller.signal);
      await loadPage("replace", undefined, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureFrom(cause));
    } finally {
      setRefreshing(false);
    }
  }, [connection, date, loadPage, subject, timezone]);

  useEffect(() => {
    if (!subject) return;
    void probeForNewRecords();
    const timer = window.setInterval(() => void probeForNewRecords(), 30_000);
    return () => window.clearInterval(timer);
  }, [probeForNewRecords, subject]);

  const availableApps = useMemo(() => [...new Set(entries.map(entry => entry.app).filter((value): value is string => Boolean(value)))].sort(), [entries]);
  const dateLabel = useMemo(() => formatDateLabel(date, timezone), [date, timezone]);

  return (
    <div className="timeline-shell" data-status={status}>
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><CircleDot size={18} /></span>
          <div><strong>Timeline</strong><span>Metaflow</span></div>
        </div>
        <div className="date-heading"><span>{dateLabel.weekday}</span><h1>{dateLabel.long}</h1></div>
        <div className="top-actions">
          <button className="icon-button mobile-filter" type="button" onClick={() => setFilterOpen(true)} title="打开过滤器" aria-label="打开过滤器"><SlidersHorizontal size={18} /></button>
          <button className={`icon-button ${refreshing ? "spinning" : ""}`} type="button" onClick={() => void refreshSource()} title="刷新数据" aria-label="刷新数据" disabled={refreshing}><RefreshCw size={18} /></button>
        </div>
      </header>

      <aside className={`filter-rail ${filterOpen ? "open" : ""}`} aria-label="Timeline 过滤器">
        <div className="mobile-rail-head"><strong>过滤器</strong><button className="icon-button" onClick={() => setFilterOpen(false)} aria-label="关闭过滤器"><X size={18} /></button></div>
        <FilterPanel date={date} setDate={setDate} filters={filters} setFilters={setFilters} apps={availableApps} timezone={timezone} />
      </aside>
      {filterOpen ? <button className="rail-scrim" aria-label="关闭过滤器" onClick={() => setFilterOpen(false)} /> : null}

      <main className="timeline-main">
        <div className="stream-meta">
          <span>{entries.length} 条已加载</span>
          <span>{timezone}</span>
          {error && status !== "error" ? <span className="inline-error" title={error.code}>{error.message}</span> : null}
        </div>
        {newRecords ? (
          <button className="new-records" type="button" onClick={() => void loadPage("replace")}>
            <Sparkles size={16} /> 有新记录 <ChevronDown size={16} />
          </button>
        ) : null}
        <TimelineState status={status} error={error} onRetry={() => void loadPage("replace")}>
          <ol className="timeline-list">
            {entries.map((entry, index) => <TimelineRow key={entry.key} entry={entry} previous={entries[index - 1]} timezone={timezone} />)}
          </ol>
          <LoadSentinel active={Boolean(nextCursor)} loading={loadingMore} onVisible={() => nextCursor && void loadPage("append", nextCursor)} />
        </TimelineState>
      </main>
    </div>
  );
}

function FilterPanel(props: {
  date: string;
  setDate(value: string): void;
  filters: TimelineFilters;
  setFilters(value: TimelineFilters): void;
  apps: string[];
  timezone: string;
}) {
  const toggleModality = (modality: TimelineEntry["modality"]) => {
    const next = props.filters.modalities.includes(modality)
      ? props.filters.modalities.filter(value => value !== modality)
      : [...props.filters.modalities, modality];
    if (next.length > 0) props.setFilters({ ...props.filters, modalities: next });
  };
  return (
    <div className="filter-content">
      <section className="filter-section">
        <label className="field-label" htmlFor="timeline-date">日期</label>
        <div className="date-control"><CalendarDays size={17} /><input id="timeline-date" type="date" value={props.date} onChange={event => props.setDate(event.target.value)} /></div>
        <button className="text-command" type="button" onClick={() => props.setDate(todayInputValue(new Date(), props.timezone))}>今天</button>
      </section>
      <section className="filter-section">
        <span className="field-label">来源</span>
        <div className="modality-list">
          {ALL_MODALITIES.map(modality => (
            <button key={modality} type="button" className={props.filters.modalities.includes(modality) ? "selected" : ""} onClick={() => toggleModality(modality)}>
              <ModalityIcon modality={modality} size={16} /><span>{modalityLabel(modality)}</span>{props.filters.modalities.includes(modality) ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
      </section>
      <section className="filter-section">
        <label className="field-label" htmlFor="app-filter">应用</label>
        <div className="select-control"><AppWindow size={16} /><select id="app-filter" value={props.filters.app ?? ""} onChange={event => props.setFilters({ ...props.filters, app: event.target.value || undefined })}><option value="">全部应用</option>{props.apps.map(app => <option key={app} value={app}>{app}</option>)}</select><ChevronDown size={15} /></div>
      </section>
      <section className="filter-section">
        <label className="field-label" htmlFor="text-filter">内容</label>
        <div className="search-control"><Search size={16} /><input id="text-filter" type="search" placeholder="搜索当前日期" value={props.filters.text ?? ""} onChange={event => props.setFilters({ ...props.filters, text: event.target.value || undefined })} /></div>
      </section>
      <section className="filter-section toggle-section">
        <Toggle icon={<ImageIcon size={16} />} label="只看图片" checked={props.filters.hasImage} onChange={checked => props.setFilters({ ...props.filters, hasImage: checked })} />
        <Toggle icon={<Focus size={16} />} label="只看前台" checked={props.filters.focused} onChange={checked => props.setFilters({ ...props.filters, focused: checked })} />
      </section>
    </div>
  );
}

function Toggle(props: { icon: ReactNode; label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="toggle-row">{props.icon}<span>{props.label}</span><input type="checkbox" checked={props.checked} onChange={event => props.onChange(event.target.checked)} /><i /></label>;
}

function TimelineRow({ entry, previous, timezone }: { entry: TimelineEntry; previous?: TimelineEntry; timezone: string }) {
  const beginsHour = !previous || formatHour(previous.at, timezone) !== formatHour(entry.at, timezone);
  return (
    <li className={`timeline-row modality-${entry.modality}`}>
      {beginsHour ? <div className="hour-rule"><time>{formatHour(entry.at, timezone)}</time></div> : null}
      <div className="time-column"><time dateTime={entry.at}>{formatTime(entry.at, timezone)}</time><span className="timeline-dot"><ModalityIcon modality={entry.modality} size={13} /></span></div>
      <article className="entry-content">
        <header><div className="entry-title"><strong>{entry.app ?? modalityLabel(entry.modality)}</strong>{entry.window ? <span>{entry.window}</span> : null}</div><span className="modality-tag">{modalityLabel(entry.modality)}</span></header>
        {entry.text ? <ExpandableText text={entry.text} /> : <p className="muted-copy">{entry.title}</p>}
        {entry.image ? <LazyThumbnail entry={entry} timezone={timezone} /> : null}
        {entry.url ? <div className="entry-url" title={entry.url}>{entry.url}</div> : null}
      </article>
    </li>
  );
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 360;
  return (
    <>
      <p className={`entry-text ${canExpand && !expanded ? "collapsed" : ""}`}>{text}</p>
      {canExpand ? (
        <button className="entry-expand" type="button" onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </>
  );
}

function LazyThumbnail({ entry, timezone }: { entry: TimelineEntry; timezone: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [requestWidth, setRequestWidth] = useState<number>();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node || !visible) return;
    const update = () => setRequestWidth(thumbnailRequestWidth(node.clientWidth, window.devicePixelRatio));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className={`thumbnail-frame ${failed ? "failed" : ""}`}>
      {visible && requestWidth && entry.image ? <img src={client.thumbnailUrl(entry.image.view, requestWidth)} alt={`${entry.app ?? "屏幕"} ${formatTime(entry.at, timezone)} 截图`} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span><ImageIcon size={20} />{failed ? "图片不可用" : ""}</span>}
    </div>
  );
}

function TimelineState(props: { status: Status; error?: { code: string; message: string }; onRetry(): void; children: ReactNode }) {
  if (props.status === "loading") return <div className="state-view"><LoaderCircle className="state-spinner" size={24} /><span>正在读取 Timeline</span></div>;
  if (props.status === "error") return <div className="state-view error"><Activity size={24} /><strong>Timeline 无法读取</strong><span>{props.error?.message}</span><button className="text-command" onClick={props.onRetry}>重试</button></div>;
  if (props.status === "empty") return <div className="state-view"><CalendarDays size={24} /><strong>这一天还没有记录</strong></div>;
  return <>{props.children}</>;
}

function LoadSentinel(props: { active: boolean; loading: boolean; onVisible(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !props.active || props.loading) return;
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) props.onVisible();
    }, { rootMargin: "500px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [props]);
  return <div ref={ref} className="load-sentinel">{props.loading ? <LoaderCircle className="state-spinner" size={19} /> : null}</div>;
}

function ModalityIcon({ modality, size }: { modality: TimelineEntry["modality"]; size: number }) {
  if (modality === "screen") return <Monitor size={size} />;
  if (modality === "audio") return <Mic2 size={size} />;
  if (modality === "input") return <Keyboard size={size} />;
  if (modality === "accessibility") return <Focus size={size} />;
  if (modality === "element") return <Menu size={size} />;
  return <Activity size={size} />;
}

function modalityLabel(modality: TimelineEntry["modality"]): string {
  return { screen: "屏幕", audio: "音频", input: "输入", accessibility: "界面", element: "元素", activity: "活动" }[modality];
}

function dedupe(entries: TimelineEntry[]): TimelineEntry[] {
  return [...new Map(entries.map(entry => [entry.key, entry])).values()];
}

function formatTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value));
}

function formatHour(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value));
}

function formatDateLabel(value: string, timezone: string): { weekday: string; long: string } {
  const date = new Date(localDatePeriod(value, timezone).start);
  return {
    weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: timezone }).format(date),
    long: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: timezone }).format(date),
  };
}

function failureFrom(cause: unknown): { code: string; message: string } {
  return cause instanceof TimelineClientError
    ? { code: cause.code, message: cause.message }
    : { code: "unexpected_error", message: cause instanceof Error ? cause.message : String(cause) };
}
