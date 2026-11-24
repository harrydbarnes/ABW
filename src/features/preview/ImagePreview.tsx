import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { readDownloadImage } from "../../lib/desktop";
import type { DownloadRecord } from "../../types";
import { formatBytes } from "./previewCache";
import { nextPdfRotation } from "./previewUtils";

const MIN_ZOOM_PERCENT = 20;
const MAX_ZOOM_PERCENT = 400;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export default memo(function ImagePreview({
  demo,
  record,
}: {
  demo: boolean;
  record: DownloadRecord;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!demo);
  const [problem, setProblem] = useState<string | null>(null);
  const [fitMode, setFitMode] = useState<"fit" | "manual">("fit");
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = canvasWrap.current;
    if (!element) {
      return;
    }
    const updateSize = () => {
      setContainerSize({
        width: Math.max(0, element.clientWidth - 48),
        height: Math.max(0, element.clientHeight - 48),
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    let createdUrl: string | null = null;
    setObjectUrl(null);
    setNaturalSize(null);
    setProblem(null);
    setFitMode("fit");
    setZoom(100);
    setRotation(0);

    if (demo) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void readDownloadImage(record.id)
      .then((bytes) => {
        if (!live) {
          return;
        }
        if (!bytes) {
          setProblem("Image preview is only available in the desktop app.");
          setLoading(false);
          return;
        }
        const ext = record.extension.trim().toLowerCase();
        const mimeType = IMAGE_MIME_TYPES[ext] ?? "application/octet-stream";
        const payload = new Uint8Array(bytes.byteLength);
        payload.set(bytes);
        const blob = new Blob([payload], { type: mimeType });
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!live) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Image preview could not be loaded.";
        setProblem(message);
        setLoading(false);
      });

    return () => {
      live = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [demo, record.extension, record.id]);

  const rotatedSwapped = rotation % 180 !== 0;
  const effectiveNaturalW = naturalSize ? (rotatedSwapped ? naturalSize.height : naturalSize.width) : 0;
  const effectiveNaturalH = naturalSize ? (rotatedSwapped ? naturalSize.width : naturalSize.height) : 0;

  let displayedZoom = zoom;
  if (fitMode === "fit" && naturalSize && containerSize.width > 0 && containerSize.height > 0) {
    const fitScale = Math.min(
      1,
      containerSize.width / Math.max(1, effectiveNaturalW),
      containerSize.height / Math.max(1, effectiveNaturalH),
    );
    displayedZoom = Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, Math.round(fitScale * 100)));
  }

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) {
        return;
      }
      event.preventDefault();
      const rawStep = Math.round(-event.deltaY * 0.14);
      const delta = rawStep === 0 ? (event.deltaY < 0 ? 10 : -10) : Math.max(-25, Math.min(25, rawStep));
      setFitMode("manual");
      setZoom((current) =>
        Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, (fitMode === "fit" ? displayedZoom : current) + delta)),
      );
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [displayedZoom, fitMode]);

  function stepZoom(delta: number) {
    const base = fitMode === "manual" ? zoom : displayedZoom;
    setFitMode("manual");
    setZoom(Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, base + delta)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (demo || event.nativeEvent.isComposing) {
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        stepZoom(20);
      } else if (event.key === "-") {
        event.preventDefault();
        stepZoom(-20);
      }
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      setRotation((current) => nextPdfRotation(current));
    }
  }

  const scale = (fitMode === "manual" ? zoom : displayedZoom) / 100;

  return (
    <div className="image-view" onKeyDown={handleKeyDown} ref={rootRef} tabIndex={0}>
      <div className="document-toolbar">
        <div className="pagination">
          <span>{record.extension ? record.extension.toUpperCase() : "IMAGE"}</span>
          {naturalSize ? (
            <span className="pdf-meta-note">
              {naturalSize.width} × {naturalSize.height}
            </span>
          ) : null}
          {!demo && record.sizeBytes > 0 ? (
            <span className="pdf-meta-note">{formatBytes(record.sizeBytes)}</span>
          ) : null}
        </div>
        <div className="zoom-control">
          <button
            aria-pressed={fitMode === "fit"}
            className={fitMode === "fit" ? "active" : undefined}
            disabled={demo}
            onClick={() => setFitMode((current) => (current === "fit" ? "manual" : "fit"))}
            title="Fit image inside pane"
            type="button"
          >
            Fit
          </button>
          <button
            className="zoom-reset"
            disabled={demo || (fitMode === "manual" && zoom === 100)}
            onClick={() => {
              setFitMode("manual");
              setZoom(100);
            }}
            title="Actual size (100%)"
            type="button"
          >
            100%
          </button>
          <button
            disabled={demo}
            onClick={() => setRotation((current) => nextPdfRotation(current))}
            title="Rotate 90° clockwise (R)"
            type="button"
          >
            Rotate{rotation ? ` ${rotation}°` : ""}
          </button>
          <button disabled={demo} onClick={() => stepZoom(-20)} title="Zoom out (Ctrl+-)" type="button">
            -
          </button>
          <span>{fitMode === "manual" ? zoom : displayedZoom}%</span>
          <button disabled={demo} onClick={() => stepZoom(20)} title="Zoom in (Ctrl++)" type="button">
            +
          </button>
        </div>
      </div>
      {problem ? (
        <div className="preview-error preview-status">
          <strong>Preview unavailable</strong>
          <p>{problem}</p>
        </div>
      ) : null}
      {loading && !problem ? (
        <div className="document-loading preview-status">
          <span className="preview-spinner" aria-hidden="true" />
          <div>
            <strong>Loading image preview</strong>
            <p>Reading the image file from your downloads folder.</p>
          </div>
        </div>
      ) : null}
      <div
        className="image-canvas"
        onClick={() => rootRef.current?.focus({ preventScroll: true })}
        ref={canvasWrap}
      >
        {objectUrl ? (
          <img
            alt={record.fileName}
            className="image-preview-img"
            onError={() => setProblem("This image format could not be decoded by the viewer.")}
            onLoad={(event) => {
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
            src={objectUrl}
            style={{
              width: naturalSize ? `${Math.max(1, Math.round(naturalSize.width * scale))}px` : undefined,
              height: naturalSize ? `${Math.max(1, Math.round(naturalSize.height * scale))}px` : undefined,
              transform: rotation ? `rotate(${rotation}deg)` : undefined,
            }}
          />
        ) : null}
      </div>
    </div>
  );
});
