/**
 * 行事写真仕分けツール
 * 撮影時刻(EXIF DateTimeOriginal)をもとに、写真を場面・行程ごとに振り分けてZIP出力する。
 * 写真とEXIFはブラウザ内だけで処理し、GPSなどの位置情報は読み取らない。
 */

export type PhotoTimeSource = 'exif' | 'modified' | null;

export type RawEvent = {
  name?: unknown;
  time?: unknown;
};

export type NormalizedEvent = {
  name: string;
  safeName: string;
  startMin: number;
};

export type SortablePhoto = {
  id: string;
  name: string;
  minutes: number | null;
  seq?: number;
  [key: string]: unknown;
};

export type PhotoGroup<T extends SortablePhoto = SortablePhoto> = {
  event: NormalizedEvent;
  photos: T[];
};

export type AssignmentResult<T extends SortablePhoto = SortablePhoto> = {
  groups: PhotoGroup<T>[];
  unsorted: T[];
};

export type PhotoSorterCore = {
  parseTimeToMinutes(hhmm: unknown): number | null;
  dateToMinutes(date: unknown): number | null;
  getExtension(filename: unknown): string;
  sanitizeName(name: unknown, fallback?: string): string;
  buildFileName(safeName: string, index1: number, ext: string): string;
  normalizeEvents(events: readonly RawEvent[] | null | undefined): NormalizedEvent[];
  assignPhotosToEvents<T extends SortablePhoto>(
    photos: readonly T[] | null | undefined,
    normEvents: readonly NormalizedEvent[],
  ): AssignmentResult<T>;
  formatMinutes(min: number | null | undefined): string;
};

const Core: PhotoSorterCore = {
  /** "HH:MM" → その日の通算分。不正なら null */
  parseTimeToMinutes(hhmm: unknown): number | null {
    if (typeof hhmm !== 'string') return null;
    const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number.parseInt(match[1] ?? '', 10);
    const minute = Number.parseInt(match[2] ?? '', 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  },

  /** Date → その日の通算分。null/不正なら null */
  dateToMinutes(date: unknown): number | null {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.getHours() * 60 + date.getMinutes();
  },

  /** ファイル名の拡張子（ドットなし・小文字）。無ければ "jpg" */
  getExtension(filename: unknown): string {
    if (typeof filename !== 'string') return 'jpg';
    const index = filename.lastIndexOf('.');
    if (index <= 0 || index === filename.length - 1) return 'jpg';
    return filename.slice(index + 1).toLowerCase();
  },

  /** 場面・行程名をフォルダ/ファイル名に使える形へ。空なら fallback */
  sanitizeName(name: unknown, fallback?: string): string {
    const cleaned = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/[\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || fallback || '場面';
  },

  /** ファイル名生成: 場面名_001.jpg（連番は1始まり・3桁ゼロ埋め） */
  buildFileName(safeName: string, index1: number, ext: string): string {
    const sequence = String(index1).padStart(3, '0');
    return `${safeName}_${sequence}.${ext}`;
  },

  /** 場面・行程入力を正規化して時刻順に並べる。 */
  normalizeEvents(events: readonly RawEvent[] | null | undefined): NormalizedEvent[] {
    const valid: Array<{ rawName: unknown; startMin: number; inputOrder: number }> = [];
    (events ?? []).forEach((event, inputOrder) => {
      const startMin = Core.parseTimeToMinutes(event?.time);
      if (startMin === null) return;
      valid.push({ rawName: event?.name, startMin, inputOrder });
    });

    valid.sort((left, right) => left.startMin - right.startMin || left.inputOrder - right.inputOrder);

    const usedNames = new Map<string, number>();
    return valid.map((event, index) => {
      const name = Core.sanitizeName(event.rawName, `場面${index + 1}`);
      const count = (usedNames.get(name) ?? 0) + 1;
      usedNames.set(name, count);
      const safeName = count === 1 ? name : `${name}(${count})`;
      return { name, safeName, startMin: event.startMin };
    });
  },

  /** 写真を場面・行程に振り分ける。 */
  assignPhotosToEvents<T extends SortablePhoto>(
    photos: readonly T[] | null | undefined,
    normEvents: readonly NormalizedEvent[],
  ): AssignmentResult<T> {
    const groups = normEvents.map((event) => ({ event, photos: [] as T[] }));
    const unsorted: T[] = [];

    (photos ?? []).forEach((photo) => {
      if (photo.minutes === null || photo.minutes === undefined) {
        unsorted.push(photo);
        return;
      }
      if (normEvents.length === 0 || photo.minutes < normEvents[0]!.startMin) {
        unsorted.push(photo);
        return;
      }

      let target = 0;
      for (let index = 0; index < normEvents.length; index += 1) {
        if (normEvents[index]!.startMin <= photo.minutes) target = index;
        else break;
      }
      groups[target]!.photos.push(photo);
    });

    const byTime = (left: SortablePhoto, right: SortablePhoto): number => {
      const leftMinutes = left.minutes ?? Number.POSITIVE_INFINITY;
      const rightMinutes = right.minutes ?? Number.POSITIVE_INFINITY;
      return (
        leftMinutes - rightMinutes ||
        (left.seq !== undefined && right.seq !== undefined ? left.seq - right.seq : 0) ||
        String(left.name).localeCompare(String(right.name))
      );
    };
    groups.forEach((group) => group.photos.sort(byTime));
    unsorted.sort((left, right) => {
      if (left.minutes !== null && left.minutes !== undefined && right.minutes !== null && right.minutes !== undefined) {
        return byTime(left, right);
      }
      if (left.minutes !== null && left.minutes !== undefined) return -1;
      if (right.minutes !== null && right.minutes !== undefined) return 1;
      return String(left.name).localeCompare(String(right.name));
    });

    return { groups, unsorted };
  },

  /** 分 → "H:MM"（表示用） */
  formatMinutes(min: number | null | undefined): string {
    if (min === null || min === undefined) return '--:--';
    const hour = Math.floor(min / 60);
    const minute = min % 60;
    return `${hour}:${String(minute).padStart(2, '0')}`;
  },
};

export { Core as PhotoSorterCore };

interface ExifrApi {
  parse(file: Blob, options: { pick: string[] }): Promise<unknown>;
}

interface JsZipFile {
  file(name: string, data: Blob): void;
}

interface JsZipFolder extends JsZipFile {
  folder(name: string): JsZipFolder;
}

interface JsZipConstructor {
  new (): JsZipFolder & {
    generateAsync(
      options: { type: 'blob'; compression: 'STORE' },
      onUpdate?: (metadata: { percent: number }) => void,
    ): Promise<Blob>;
  };
}

interface ModalApi {
  alert(message: string): Promise<void>;
  confirm(message: string, options?: { danger?: boolean }): Promise<boolean>;
}

declare global {
  interface Window {
    exifr?: ExifrApi;
    JSZip?: JsZipConstructor;
    PhotoSorterCore?: PhotoSorterCore;
  }
}

type PhotoRecord = SortablePhoto & {
  file: File;
  url: string;
  exifTime: Date | null;
  modifiedTime: Date | null;
  time: Date | null;
  timeSource: PhotoTimeSource;
  seq: number;
};

type PhotoWithTime = PhotoRecord & { minutes: number };
type DownloadStatus = 'idle' | 'preparing' | 'ready' | 'error';
type FilenameMode = 'event-seq' | 'time-original' | 'original' | 'seq-only';

type AppState = {
  photos: PhotoRecord[];
  result: AssignmentResult<PhotoRecord> | null;
  norm: NormalizedEvent[];
  loadToken: number;
  downloadStatus: DownloadStatus;
  downloadUrl: string | null;
};

const UNSORTED_LABEL = '未分類';
const LARGE_WARN_BYTES = 800 * 1024 * 1024;
const LARGE_DANGER_BYTES = 1500 * 1024 * 1024;

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function elementById<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`必要な画面要素が見つかりません: #${id}`);
  return element as T;
}

function queryElement<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`必要な画面要素が見つかりません: ${selector}`);
  return element;
}

function optionalElement<T extends Element>(parent: ParentNode, selector: string): T | null {
  return parent.querySelector<T>(selector);
}

function getModal(): ModalApi {
  const candidate: unknown = (window as Window & { Modal?: unknown }).Modal;
  if (isRecord(candidate) && typeof candidate.alert === 'function' && typeof candidate.confirm === 'function') {
    return candidate as unknown as ModalApi;
  }
  return {
    alert: async (message: string) => window.alert(message),
    confirm: async (message: string) => window.confirm(message),
  };
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

function sanitizeFileName(filename: unknown, fallback: string): string {
  const cleaned = String(filename || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback || 'photo.jpg';
}

function makeUniqueFileName(filename: string, used: Record<string, boolean>): string {
  const extension = Core.getExtension(filename);
  const index = filename.lastIndexOf('.');
  const hasExtension = index > 0 && index < filename.length - 1;
  const base = hasExtension ? filename.slice(0, index) : filename || 'photo';
  let candidate = hasExtension ? filename : `${base}.${extension}`;
  let count = 1;
  while (used[candidate] === true) {
    count += 1;
    candidate = `${base}_${count}.${extension}`;
  }
  used[candidate] = true;
  return candidate;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatTimeCompact(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

function initializePhotoSorter(): void {
  const dropZone = elementById<HTMLElement>('dropZone');
  const fileInput = elementById<HTMLInputElement>('fileInput');
  const folderInput = elementById<HTMLInputElement>('folderInput');
  const loadStatus = elementById<HTMLElement>('loadStatus');
  const photoSummary = elementById<HTMLElement>('photoSummary');
  const timeHistogram = elementById<HTMLElement>('timeHistogram');
  const eventList = elementById<HTMLElement>('eventList');
  const useModifiedTime = elementById<HTMLInputElement>('useModifiedTime');
  const fileNameMode = elementById<HTMLSelectElement>('fileNameMode');
  const preflightPanel = elementById<HTMLElement>('preflightPanel');
  const step2 = elementById<HTMLElement>('step2');
  const step3 = elementById<HTMLElement>('step3');
  const step4 = elementById<HTMLElement>('step4');
  const previewArea = elementById<HTMLElement>('previewArea');
  const zipButton = elementById<HTMLButtonElement>('zipBtn');
  const zipProgress = elementById<HTMLElement>('zipProgress');
  const zipProgressText = elementById<HTMLElement>('zipProgressText');
  const zipResult = elementById<HTMLElement>('zipResult');
  const selectFilesButton = elementById<HTMLButtonElement>('selectFilesBtn');
  const selectFolderButton = elementById<HTMLButtonElement>('selectFolderBtn');
  const state: AppState = {
    photos: [],
    result: null,
    norm: [],
    loadToken: 0,
    downloadStatus: 'idle',
    downloadUrl: null,
  };
  const libsOk = window.exifr !== undefined && window.JSZip !== undefined;

  const revokeDownloadUrl = (): void => {
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  };

  const getTotalBytes = (): number => state.photos.reduce((sum, photo) => sum + photo.file.size, 0);
  const withTime = (): PhotoWithTime[] => state.photos.filter((photo): photo is PhotoWithTime => photo.minutes !== null);

  const setLoadError = (message: string): void => {
    loadStatus.innerHTML = `<i class="fas fa-triangle-exclamation" style="color:var(--danger-color)"></i> ${escapeHtml(message)}`;
  };

  const pickPhotoTime = (exifTime: Date | null, modifiedTime: Date | null): { time: Date | null; source: PhotoTimeSource } => {
    if (isFiniteDate(exifTime)) return { time: exifTime, source: 'exif' };
    if (useModifiedTime.checked && isFiniteDate(modifiedTime)) return { time: modifiedTime, source: 'modified' };
    return { time: null, source: null };
  };

  const applyTimeFallback = (): void => {
    state.photos.forEach((photo) => {
      const picked = pickPhotoTime(photo.exifTime, photo.modifiedTime);
      photo.time = picked.time;
      photo.timeSource = picked.source;
      photo.minutes = Core.dateToMinutes(picked.time);
    });
  };

  const formatPhotoTime = (photo: PhotoRecord): string => {
    if (photo.minutes === null) return '時刻不明';
    return `${Core.formatMinutes(photo.minutes)}${photo.timeSource === 'modified' ? ' 更新日時' : ''}`;
  };

  const getFileNameModeLabel = (): string => {
    const option = fileNameMode.options[fileNameMode.selectedIndex];
    return option?.textContent ?? '場面名_001.jpg';
  };

  const buildOutputFileName = (
    photo: PhotoRecord,
    index1: number,
    safeName: string,
    used: Record<string, boolean>,
    isUnsorted: boolean,
  ): string => {
    const extension = Core.getExtension(photo.name);
    const mode = fileNameMode.value as FilenameMode;
    let candidate: string;
    if (mode === 'original' || (isUnsorted && mode === 'event-seq')) {
      candidate = sanitizeFileName(photo.name, `photo.${extension}`);
    } else if (mode === 'time-original') {
      const prefix = photo.minutes === null ? '時刻不明' : formatTimeCompact(photo.minutes);
      candidate = `${prefix}_${sanitizeFileName(photo.name, `photo.${extension}`)}`;
    } else if (mode === 'seq-only') {
      candidate = `${String(index1).padStart(3, '0')}.${extension}`;
    } else {
      candidate = Core.buildFileName(safeName, index1, extension);
    }
    return makeUniqueFileName(candidate, used);
  };

  const renderSummary = (): void => {
    const timedPhotos = withTime();
    const noTime = state.photos.length - timedPhotos.length;
    const fallbackCount = state.photos.filter((photo) => photo.timeSource === 'modified').length;
    const totalBytes = getTotalBytes();
    let html = `<strong>${state.photos.length}枚</strong> の写真を読み込みました。`;
    if (timedPhotos.length > 0) {
      const minutes = timedPhotos.map((photo) => photo.minutes);
      const min = Math.min(...minutes);
      const max = Math.max(...minutes);
      html += `<br>撮影時刻の範囲：<strong>${Core.formatMinutes(min)}</strong> 〜 <strong>${Core.formatMinutes(max)}</strong>`;
    }
    html += `<br>合計サイズ：約<strong>${formatBytes(totalBytes)}</strong>`;
    if (fallbackCount > 0) html += `<br><span class="summary-warn"><i class="fas fa-clock-rotate-left"></i> ${fallbackCount}枚はファイル更新日時で仮判定しています。</span>`;
    if (noTime > 0) html += `<br><span class="summary-warn"><i class="fas fa-triangle-exclamation"></i> ${noTime}枚は撮影時刻が不明です（「未分類」フォルダにまとめます）。</span>`;
    if (totalBytes >= LARGE_DANGER_BYTES) html += '<br><span class="summary-warn"><i class="fas fa-triangle-exclamation"></i> 写真がかなり大きいため、PCのメモリ不足でZIP作成に失敗する可能性があります。</span>';
    else if (totalBytes >= LARGE_WARN_BYTES) html += '<br><span class="summary-warn"><i class="fas fa-circle-info"></i> 写真が多めです。ZIP作成に時間がかかる場合があります。</span>';
    photoSummary.innerHTML = html;
    photoSummary.style.display = '';
  };

  const renderTimeHistogram = (): void => {
    const timedPhotos = withTime();
    if (timedPhotos.length === 0) {
      timeHistogram.innerHTML = '<div class="histogram-empty"><i class="fas fa-circle-info"></i> 表示できる撮影時刻がありません。</div>';
      timeHistogram.style.display = '';
      return;
    }
    const minutes = timedPhotos.map((photo) => photo.minutes);
    const min = Math.min(...minutes);
    const max = Math.max(...minutes);
    const span = max - min;
    const unit = span <= 180 ? 15 : span <= 360 ? 30 : 60;
    const start = Math.floor(min / unit) * unit;
    const end = Math.ceil((max + 1) / unit) * unit;
    const buckets: Array<{ start: number; end: number; count: number }> = [];
    for (let cursor = start; cursor <= end; cursor += unit) buckets.push({ start: cursor, end: cursor + unit, count: 0 });
    timedPhotos.forEach((photo) => buckets.find((bucket) => photo.minutes >= bucket.start && photo.minutes < bucket.end)!.count += 1);
    const maxCount = Math.max(...buckets.map((bucket) => bucket.count), 1);
    const bars = buckets.map((bucket) => {
      const height = Math.max(4, Math.round((bucket.count / maxCount) * 92));
      return `<div class="histogram-bar" title="${escapeAttr(Core.formatMinutes(bucket.start))}〜${escapeAttr(Core.formatMinutes(bucket.end))}：${bucket.count}枚"><span class="histogram-bar-count">${bucket.count}</span><div class="histogram-bar-fill" style="height:${height}px"></div><span class="histogram-bar-time">${escapeHtml(Core.formatMinutes(bucket.start))}</span></div>`;
    }).join('');
    timeHistogram.innerHTML = `<div class="histogram-head"><span><i class="fas fa-chart-column"></i> 写真の時間分布</span><span>${unit}分ごと</span></div><div class="histogram-bars">${bars}</div>`;
    timeHistogram.style.display = '';
  };

  const clearPreview = (): void => {
    state.result = null;
    state.downloadStatus = 'idle';
    revokeDownloadUrl();
    step3.style.display = 'none';
    step4.style.display = 'none';
    zipResult.style.display = 'none';
    preflightPanel.replaceChildren();
  };

  const makeEventRow = (time: string, name: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `<input type="time" class="ev-time" value="${escapeAttr(time)}"><input type="text" class="ev-name" placeholder="例：開会式 / 合唱 2年1組" value="${escapeAttr(name)}"><button type="button" class="del-event-btn" title="この項目を削除"><i class="fas fa-xmark"></i></button>`;
    queryElement<HTMLButtonElement>(row, '.del-event-btn').addEventListener('click', () => {
      row.remove();
      if (eventList.children.length === 0) seedEventRows();
    });
    return row;
  };

  const seedEventRows = (): void => {
    eventList.append(makeEventRow('', ''), makeEventRow('', ''));
  };

  const prefillFirstEventTime = (): void => {
    const firstInput = optionalElement<HTMLInputElement>(eventList, '.ev-time');
    if (!firstInput || firstInput.value) return;
    const timedPhotos = withTime();
    if (timedPhotos.length === 0) return;
    const min = Math.min(...timedPhotos.map((photo) => photo.minutes));
    firstInput.value = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  };

  const collectEvents = (): RawEvent[] => [...eventList.querySelectorAll<HTMLElement>('.event-row')].map((row) => ({
    time: queryElement<HTMLInputElement>(row, '.ev-time').value,
    name: queryElement<HTMLInputElement>(row, '.ev-name').value,
  }));

  const buildMoveSelect = (photo: PhotoRecord, currentKey: string): string => {
    const options = state.norm.map((event) => `<option value="${escapeAttr(event.safeName)}"${event.safeName === currentKey ? ' selected' : ''}>${escapeHtml(event.safeName)}</option>`).join('');
    return `<select class="photo-move-select" data-photo-id="${escapeAttr(photo.id)}" aria-label="移動先を選ぶ">${options}<option value="${escapeAttr(UNSORTED_LABEL)}"${currentKey === UNSORTED_LABEL ? ' selected' : ''}>${UNSORTED_LABEL}</option></select>`;
  };

  const buildEventCard = (name: string, range: string, photos: readonly PhotoRecord[], isUnsorted: boolean): HTMLElement => {
    const card = document.createElement('div');
    card.className = `event-card${isUnsorted ? ' is-unsorted' : ''}${photos.length === 0 ? ' is-empty' : ''}`;
    const head = document.createElement('div');
    head.className = 'event-card-head';
    head.innerHTML = `<span class="ec-name"><i class="fas ${isUnsorted ? 'fa-folder-minus' : 'fa-folder'}"></i> ${escapeHtml(name)}</span><span class="ec-time">${escapeHtml(range)}</span><span class="ec-count">${photos.length}枚</span>`;
    card.appendChild(head);
    if (photos.length === 0) {
      const message = document.createElement('div');
      message.className = 'ec-empty-msg';
      message.innerHTML = '<i class="fas fa-circle-info"></i> この項目に該当する写真はありませんでした。';
      card.appendChild(message);
      return card;
    }
    const thumbs = document.createElement('div');
    thumbs.className = 'event-card-thumbs';
    const used: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
    photos.forEach((photo, index) => {
      const newName = buildOutputFileName(photo, index + 1, name, used, isUnsorted);
      const thumb = document.createElement('div');
      thumb.className = 'ec-thumb';
      thumb.innerHTML = `<img src="${escapeAttr(photo.url)}" alt="" loading="lazy"><span class="ec-thumb-name" title="${escapeAttr(newName)}">${escapeHtml(newName)}</span><span class="ec-thumb-meta">${escapeHtml(formatPhotoTime(photo))}</span>${buildMoveSelect(photo, isUnsorted ? UNSORTED_LABEL : name)}`;
      thumbs.appendChild(thumb);
    });
    card.appendChild(thumbs);
    return card;
  };

  const renderPreview = (): void => {
    if (!state.result) return;
    previewArea.replaceChildren();
    state.result.groups.forEach((group, index) => {
      const next = state.norm[index + 1];
      const range = `${Core.formatMinutes(group.event.startMin)}〜${next ? Core.formatMinutes(next.startMin) : '最後'}`;
      previewArea.appendChild(buildEventCard(group.event.safeName, range, group.photos, false));
    });
    if (state.result.unsorted.length > 0) previewArea.appendChild(buildEventCard(UNSORTED_LABEL, '時刻対象外', state.result.unsorted, true));
  };

  type Preflight = { level: 'ok' | 'warning' | 'danger'; items: string[]; icon: string; title: string; confirmMessage: string };
  const getPreflight = (): Preflight | null => {
    if (!state.result) return null;
    const { groups, unsorted } = state.result;
    const totalBytes = getTotalBytes();
    const noTime = state.photos.filter((photo) => photo.timeSource === null).length;
    const fallbackCount = state.photos.filter((photo) => photo.timeSource === 'modified').length;
    const emptyGroups = groups.filter((group) => group.photos.length === 0);
    const items = [`ZIPに入る写真：${groups.reduce((sum, group) => sum + group.photos.length, 0) + unsorted.length}枚`, `合計サイズ：約${formatBytes(totalBytes)}`, `ファイル名ルール：${getFileNameModeLabel()}`];
    let level: Preflight['level'] = 'ok';
    if (unsorted.length > 0) { level = 'warning'; items.push(`未分類：${unsorted.length}枚あります。必要ならプレビューで移動してください。`); }
    if (noTime > 0) { level = 'warning'; items.push(`撮影時刻なし：${noTime}枚あります。`); }
    if (fallbackCount > 0) { level = 'warning'; items.push(`ファイル更新日時で仮判定：${fallbackCount}枚あります。`); }
    if (emptyGroups.length > 0) { level = 'warning'; items.push(`写真が入っていない場面・行程：${emptyGroups.map((group) => group.event.safeName).join('、')}`); }
    if (totalBytes >= LARGE_DANGER_BYTES) { level = 'danger'; items.push('写真サイズがかなり大きいため、ZIP作成に失敗する可能性があります。'); }
    else if (totalBytes >= LARGE_WARN_BYTES) { if (level === 'ok') level = 'warning'; items.push('写真が多めです。ZIP作成に時間がかかる場合があります。'); }
    return { level, items, icon: level === 'ok' ? 'fa-circle-check' : level === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-info', title: level === 'ok' ? '準備できています' : 'ZIP作成前に確認してください', confirmMessage: `${items.join('\n')}\n\nこの内容でZIPを作成しますか？` };
  };

  const renderPreflight = (): void => {
    const preflight = getPreflight();
    if (!preflight) return;
    preflightPanel.className = `preflight-panel${preflight.level === 'danger' ? ' is-danger' : preflight.level === 'warning' ? ' is-warning' : ''}`;
    preflightPanel.innerHTML = `<div class="preflight-title"><i class="fas ${preflight.icon}"></i> ${escapeHtml(preflight.title)}</div><ul class="preflight-list">${preflight.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  };

  const movePhotoToGroup = (photoId: string | undefined, targetKey: string): void => {
    if (!state.result || !photoId) return;
    let targetPhoto: PhotoRecord | undefined;
    state.result.groups.forEach((group) => {
      const index = group.photos.findIndex((photo) => photo.id === photoId);
      if (index >= 0) targetPhoto = group.photos.splice(index, 1)[0];
    });
    if (!targetPhoto) {
      const index = state.result.unsorted.findIndex((photo) => photo.id === photoId);
      if (index >= 0) targetPhoto = state.result.unsorted.splice(index, 1)[0];
    }
    if (!targetPhoto) return;
    if (targetKey === UNSORTED_LABEL) state.result.unsorted.push(targetPhoto);
    else state.result.groups.find((group) => group.event.safeName === targetKey)?.photos.push(targetPhoto) ?? state.result.unsorted.push(targetPhoto);
    renderPreview();
    renderPreflight();
    zipResult.style.display = 'none';
    state.downloadStatus = 'idle';
    revokeDownloadUrl();
  };

  const isImageFile = (file: File): boolean => file.type.startsWith('image/') || /\.(jpe?g|png|tiff?|heic|heif)$/i.test(file.name);

  const handleFiles = async (fileList: FileList | null): Promise<void> => {
    if (!libsOk) { setLoadError('必要なライブラリの読み込みに失敗しているため、写真を読み込めません。通信環境を確認して再読み込みしてください。'); return; }
    const files = [...(fileList ?? [])].filter(isImageFile);
    if (files.length === 0) { loadStatus.innerHTML = '<i class="fas fa-circle-info"></i> 画像ファイルが見つかりませんでした。'; return; }
    const loadToken = ++state.loadToken;
    selectFilesButton.disabled = true;
    selectFolderButton.disabled = true;
    state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    state.photos = [];
    state.result = null;
    state.norm = [];
    clearPreview();
    loadStatus.innerHTML = `<div class="spinner"></div> 撮影時刻を読み取り中... (0/${files.length})`;
    let done = 0;
    try {
      for (const file of files) {
        let exifTime: Date | null = null;
        try {
          const exif = await window.exifr?.parse(file, { pick: ['DateTimeOriginal'] });
          if (isRecord(exif) && isFiniteDate(exif.DateTimeOriginal)) exifTime = exif.DateTimeOriginal;
        } catch (_error: unknown) {
          // EXIFなし・読み取り不能は未分類扱いにする。
        }
        if (loadToken !== state.loadToken) return;
        const modifiedTime = file.lastModified > 0 ? new Date(file.lastModified) : null;
        const picked = pickPhotoTime(exifTime, modifiedTime);
        const sequence = state.photos.length;
        state.photos.push({ id: `p${sequence}`, file, name: file.name, url: URL.createObjectURL(file), exifTime, modifiedTime, time: picked.time, timeSource: picked.source, minutes: Core.dateToMinutes(picked.time), seq: sequence });
        done += 1;
        if (done % 5 === 0 || done === files.length) loadStatus.innerHTML = `<div class="spinner"></div> 撮影時刻を読み取り中... (${done}/${files.length})`;
      }
      if (loadToken !== state.loadToken) return;
      renderSummary();
      renderTimeHistogram();
      loadStatus.innerHTML = `<i class="fas fa-circle-check" style="color:var(--success-color)"></i> ${state.photos.length} 枚を読み込みました。`;
      step2.style.display = '';
      if (eventList.children.length === 0) seedEventRows();
      prefillFirstEventTime();
      step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      if (loadToken === state.loadToken) { selectFilesButton.disabled = false; selectFolderButton.disabled = false; }
    }
  };

  const initializeEvents = (): void => {
    selectFilesButton.addEventListener('click', () => fileInput.click());
    selectFolderButton.addEventListener('click', () => folderInput.click());
    fileInput.addEventListener('change', (event) => { const target = event.target; if (target instanceof HTMLInputElement) void handleFiles(target.files); });
    folderInput.addEventListener('change', (event) => { const target = event.target; if (target instanceof HTMLInputElement) void handleFiles(target.files); });
    useModifiedTime.addEventListener('change', () => { if (state.photos.length === 0) return; applyTimeFallback(); renderSummary(); renderTimeHistogram(); clearPreview(); });
    fileNameMode.addEventListener('change', () => { if (state.result) { renderPreview(); renderPreflight(); } });
    ['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('drag-active'); }));
    ['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); if (eventName === 'dragleave' && event instanceof DragEvent && event.relatedTarget instanceof Node && dropZone.contains(event.relatedTarget)) return; dropZone.classList.remove('drag-active'); }));
    dropZone.addEventListener('drop', (event) => { if (event instanceof DragEvent && event.dataTransfer) void handleFiles(event.dataTransfer.files); });
    elementById<HTMLButtonElement>('addEventBtn').addEventListener('click', () => eventList.appendChild(makeEventRow('', '')));
    elementById<HTMLButtonElement>('previewBtn').addEventListener('click', async () => {
      if (state.photos.length === 0) { await getModal().alert('先に写真を読み込んでください。'); return; }
      const norm = Core.normalizeEvents(collectEvents());
      if (norm.length === 0) { await getModal().alert('場面・行程の開始時刻と名前を1つ以上入力してください。\n（時刻は「09:00」の形式です）'); return; }
      state.norm = norm;
      state.result = Core.assignPhotosToEvents(state.photos, norm);
      renderPreview();
      renderPreflight();
      step3.style.display = '';
      step4.style.display = '';
      zipResult.style.display = 'none';
      step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    previewArea.addEventListener('change', (event) => { const target = event.target; if (target instanceof HTMLSelectElement && target.classList.contains('photo-move-select')) movePhotoToGroup(target.dataset.photoId, target.value); });
  };

  const initializeDownload = (): void => {
    zipButton.addEventListener('click', async () => {
      if (!state.result) { await getModal().alert('先に「自動で振り分ける」を実行してください。'); return; }
      if (!window.JSZip) { await getModal().alert('ライブラリの読み込みに失敗しているためZIPを作成できません。'); return; }
      const preflight = getPreflight();
      if (!preflight) return;
      if (preflight.level !== 'ok' && !(await getModal().confirm(preflight.confirmMessage, { danger: preflight.level === 'danger' }))) return;
      zipButton.disabled = true;
      zipProgress.style.display = 'flex';
      zipResult.style.display = 'none';
      state.downloadStatus = 'preparing';
      revokeDownloadUrl();
      try {
        const zip = new window.JSZip();
        let total = 0;
        state.result.groups.forEach((group) => {
          if (group.photos.length === 0) return;
          const folder = zip.folder(group.event.safeName);
          const used: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
          group.photos.forEach((photo, index) => { folder.file(buildOutputFileName(photo, index + 1, group.event.safeName, used, false), photo.file); total += 1; });
        });
        if (state.result.unsorted.length > 0) {
          const folder = zip.folder(UNSORTED_LABEL);
          const used: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
          state.result.unsorted.forEach((photo, index) => { folder.file(buildOutputFileName(photo, index + 1, UNSORTED_LABEL, used, true), photo.file); total += 1; });
        }
        zipProgressText.textContent = `ZIPを作成中...（${total}枚を圧縮）`;
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => { zipProgressText.textContent = `ZIPを作成中... ${Math.round(metadata.percent)}%`; });
        const today = new Date();
        const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        const zipName = `行事写真_${ymd}.zip`;
        state.downloadUrl = URL.createObjectURL(blob);
        state.downloadStatus = 'ready';
        const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
        zipResult.innerHTML = `<i class="fas fa-circle-check"></i> ZIPを作成しました（${total}枚 / 約${sizeMB}MB）。<br><a class="btn btn-success download-link" href="${escapeAttr(state.downloadUrl)}" download="${escapeAttr(zipName)}"><i class="fas fa-download"></i> ${escapeHtml(zipName)} を保存</a>`;
        zipResult.style.display = 'block';
      } catch (error: unknown) {
        state.downloadStatus = 'error';
        const message = error instanceof Error ? error.message : String(error);
        await getModal().alert(`ZIPの作成中にエラーが発生しました：${message}`);
      } finally {
        zipProgress.style.display = 'none';
        zipButton.disabled = false;
      }
    });
  };

  if (!libsOk) {
    setLoadError('必要なライブラリの読み込みに失敗しました。通信環境を確認して再読み込みしてください。');
    selectFilesButton.disabled = true;
    selectFolderButton.disabled = true;
  }
  initializeEvents();
  initializeDownload();
}

if (typeof window !== 'undefined') {
  window.PhotoSorterCore = Core;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializePhotoSorter, { once: true });
    else initializePhotoSorter();
  }
}
