import type { CSSProperties } from "react";

export type FileKind = "pdf" | "spreadsheet" | "document" | "image" | "other";

export interface DownloadRecord {
  id: string;
  fileName: string;
  extension: string;
  kind: FileKind;
  downloadedAt: string;
  sizeBytes: number;
  sourceUrl: string | null;
  sourceLabel: string;
  previewed?: boolean;
  demo?: boolean;
}

export interface FavoriteTicket {
  id: string;
  title: string;
  url: string;
  client?: string;
  details?: string;
  addedAt: string;
}

export interface VisitHistoryEntry {
  id: string;
  title: string;
  url: string;
  client?: string;
  details?: string;
  lastVisitedAt: string;
  visitCount: number;
}

export interface Settings {
  spellCheck: boolean;
  showSpellCheckInTopbar: boolean;
  launchWrikeOnStart: boolean;
  showLaunchSplash: boolean;
  downloadNotifications: boolean;
  openAbwAtSystemStartup: boolean;
  startMinimizedToTray: boolean;
  closeToNotificationArea: boolean;
  suspendTabsOnTrayHide: boolean;
  confirmBeforeClosingTabs: boolean;
  openDownloadedFilesAutomatically: boolean;
  openExternalLinksInBrowser: boolean;
  customContextMenu: boolean;
  useNativeWrikeImageViewer: boolean;
  autoCheckForUpdates: boolean;
  autoMatchWrikeTheme: boolean;
  enableFinanceTab: boolean;
  suspendInactiveTabsMinutes: number;
  theme: AppThemeId;
  customDictionary: string[];
  startupTabUrls: string[];
  pinnedDownloadIds: string[];
  favoriteTickets: FavoriteTicket[];
  visitHistory: VisitHistoryEntry[];
  lastWrikeSession: WrikeSession | null;
}

export type AppUpdateCheckStatus = "available" | "up-to-date" | "no-release";

export interface AppUpdateCheckResult {
  status: AppUpdateCheckStatus;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  pubDate: string | null;
}

export type AppUpdateDownloadEvent =
  | { event: "started"; data: { contentLength: number | null } }
  | {
      event: "progress";
      data: {
        chunkLength: number;
        downloaded: number;
        contentLength: number | null;
      };
    }
  | { event: "finished" };

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "no-release"
  | "downloading"
  | "installing"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  latestVersion: string | null;
  notes: string | null;
  pubDate: string | null;
  checkedAt: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  dismissedPrompt: boolean;
}

export interface WrikeSessionTab {
  id: string;
  title: string;
  url: string | null;
  mode: "standard" | "readOnly";
}

export interface WrikeSession {
  tabs: WrikeSessionTab[];
  activeTabId: string;
  split: {
    leftTabId: string;
    rightTabId: string;
  } | null;
  savedAt: string;
}

export interface WorkbookImage {
  dataUrl: string;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export interface WorkbookSheet {
  name: string;
  columns: WorkbookColumn[];
  rows: WorkbookRow[];
  truncatedRows?: boolean;
  truncatedColumns?: boolean;
  hasImages?: boolean;
  deferred?: boolean;
}

export interface WorkbookColumn {
  index: number;
  label: string;
  widthPx: number;
}

export interface WorkbookRow {
  index: number;
  heightPx: number;
  cells: WorkbookCell[];
}

export interface WorkbookCell {
  value?: string;
  style?: CSSProperties;
  styleIndex?: number;
  colSpan?: number;
  rowSpan?: number;
  coveredByMerge?: boolean;
}

export interface WorkbookPreview {
  sheets: WorkbookSheet[];
  styles?: CSSProperties[];
  activeSheet: number;
}

export interface DownloadsStorageStats {
  totalFiles: number;
  pinnedFiles: number;
  totalBytes: number;
  unpinnedBytes: number;
}

export interface ClearDownloadsResult {
  removedCount: number;
  freedBytes: number;
}

export type FileFilter = "all" | FileKind | "previewed";

export const APP_THEMES = [
  { id: "default", label: "Default" },
  { id: "midnight", label: "Midnight" },
  { id: "halloween", label: "Halloween" },
  { id: "winter-holiday", label: "Winter holiday" },
  { id: "winter-white", label: "Winter white" },
  { id: "merlot", label: "Merlot" },
  { id: "blue-skies", label: "Blue skies" },
  { id: "blueberry-pie", label: "Blueberry pie" },
  { id: "imperial-purple", label: "Imperial purple" },
  { id: "cappuccino", label: "Cappuccino" },
  { id: "blue-steel", label: "Blue steel" },
  { id: "aquamarine", label: "Aquamarine" },
  { id: "legendary-leopard", label: "Legendary leopard" },
  { id: "velvet-cosmos", label: "Velvet cosmos" },
  { id: "monochrome", label: "Monochrome" },
  { id: "pumpkin-spice", label: "Pumpkin spice" },
  { id: "flamingo", label: "Flamingo" },
  { id: "cool-confetti", label: "Cool confetti" },
  { id: "woodland-grass", label: "Woodland grass" },
] as const;

export type AppThemeId = (typeof APP_THEMES)[number]["id"];

export type MqsSource = "mxLive" | "emailDigest" | "manualImport";

export interface MqsTicket {
  ticketNo: string;
  toBuyer: string;
  advertiser: string;
  payee: string;
  invoiceNo: string;
  created: string;
  lineNo: string;
  currency: string;
  queriedPayable: number;
  queriedGross: number;
  bookingReference: string;
  reason: string;
  status: string;
  priority: string;
  owner: string;
  operatingCo: string;
  buyingAgency: string;
  clientCode: string;
  issuedDate: string;
  invoiceGross: number | null;
  invoiceNetPayable: number | null;
  invoiceTotalPayable: number | null;
  attachments: string[];
  localNotes: string;
  source: MqsSource;
  lastSeenAt: string;
}

export interface PrismaOrder {
  orderVer: string;
  orderBase: string;
  status: string;
  dueLabel: string;
  dueInDays: number | null;
  media: string;
  orderType: string;
  seller: string;
  mediaId: string;
  clientId: string;
  productId: string;
  estimateId: string;
  orderTotal: number;
  currency: string;
  campaign: string;
  campaignId: string;
  dates: string;
  startDate: string;
  endDate: string;
  buyer: string;
  agency: string;
  orderUrl: string;
  lastSeenAt: string;
}

export interface FinanceFavouriteFilter {
  id: string;
  name: string;
  buyers: string[];
  clients: string[];
  agencies: string[];
  notify: boolean;
  builtIn: boolean;
}

export type OrderRiskLevel =
  | "accepted_with_mqs"
  | "rejected"
  | "sent_urgent"
  | "sent_watch"
  | "healthy";

export interface MatchedOrderView {
  order: PrismaOrder;
  riskLevel: OrderRiskLevel;
  riskReason: string;
  linkedTicketNos: string[];
  linkedQueriedTotal: number;
}

export interface MatchedTicketView {
  ticket: MqsTicket;
  normalizedRefs: string[];
  linkedOrderVer: string | null;
  linkedOrderStatus: string | null;
  linkedCampaign: string | null;
  linkedSeller: string | null;
}

export interface MxBuyerEntry {
  code: string;
  name: string;
}

export interface FinanceSyncStatus {
  mxRunning: boolean;
  mxLastSyncAt: string | null;
  mxLastSource: MqsSource | null;
  mxEnvironment: string | null;
  prismaPaired: boolean;
  prismaLastSyncAt: string | null;
  digestFolder: string | null;
  lastError: string | null;
}

export interface FinanceSnapshot {
  tickets: MatchedTicketView[];
  orders: MatchedOrderView[];
  favourites: FinanceFavouriteFilter[];
  activeFavouriteId: string;
  digestFolder: string | null;
  syncStatus: FinanceSyncStatus;
  notifyBadgeCount: number;
}

export interface MqsActionRequest {
  ticketNo: string;
  action: string;
  comments: string;
  toBuyer: string;
  serial: string;
  submit: boolean;
}

export interface MqsActionResult {
  ok: boolean;
  message: string;
  submitted: boolean;
}

export interface PrismaOrderActionRequest {
  orderVer: string;
  action: "agency_accept" | "request_revision";
  reason: string;
}

export interface PrismaOrderActionResult {
  ok: boolean;
  status: string;
  message: string;
}
