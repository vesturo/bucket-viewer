const DEFAULT_BUCKET_ID = "somnium";
const DISCLAIMER_STORAGE_KEY = "s3-bucket-viewer-disclaimer-accepted-v1";
const BUCKET_PRESETS = {
  "somnium": {
    id: "somnium",
    label: "Somnium",
    bucketName: "somnium",
    listEndpoint: "https://ai-space.fra1.cdn.digitaloceanspaces.com/",
    objectBaseUrl: "https://ai-space.fra1.cdn.digitaloceanspaces.com/",
    hasSnapshotFallback: true,
  },
};
const COMMUNITY_ASSET_RE = /^ai-space\/website\/community-assets\/([^/]+)\/([^/]+)\/(files|images)\/(.+)$/;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const PACKAGE_EXTENSIONS = new Set(["unitypackage", "zip"]);

const state = {
  entries: [],
  bucketId: DEFAULT_BUCKET_ID,
  view: "assets",
  imageLayout: "gallery",
  query: "",
  sort: "modified-desc",
  bucket: BUCKET_PRESETS[DEFAULT_BUCKET_ID].bucketName,
  isTruncated: false,
  nextMarker: "",
  pagesLoaded: 0,
  snapshotLoaded: false,
  loadingLive: false,
  autoLoadEnabled: true,
  lightboxImages: [],
  lightboxIndex: -1,
};

const dom = {
  corporateDisclaimer: document.querySelector("#corporateDisclaimer"),
  acceptDisclaimerButton: document.querySelector("#acceptDisclaimerButton"),
  loadLiveButton: document.querySelector("#loadLiveButton"),
  loadNextButton: document.querySelector("#loadNextButton"),
  notice: document.querySelector("#notice"),
  bucketSelect: document.querySelector("#bucketSelect"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  viewButtons: [...document.querySelectorAll("[data-view]")],
  imageLayoutControl: document.querySelector("#imageLayoutControl"),
  imageLayoutButtons: [...document.querySelectorAll("[data-image-layout]")],
  results: document.querySelector("#results"),
  resultsTitle: document.querySelector("#resultsTitle"),
  resultsCount: document.querySelector("#resultsCount"),
  statObjects: document.querySelector("#statObjects"),
  statFiles: document.querySelector("#statFiles"),
  statImages: document.querySelector("#statImages"),
  statPackages: document.querySelector("#statPackages"),
  statAssets: document.querySelector("#statAssets"),
  scrollSentinel: document.querySelector("#scrollSentinel"),
  lightbox: document.querySelector("#lightbox"),
  lightboxClose: document.querySelector("#lightboxClose"),
  lightboxPrev: document.querySelector("#lightboxPrev"),
  lightboxNext: document.querySelector("#lightboxNext"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxTitle: document.querySelector("#lightboxTitle"),
  lightboxMeta: document.querySelector("#lightboxMeta"),
  lightboxKey: document.querySelector("#lightboxKey"),
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function getActivePreset() {
  return BUCKET_PRESETS[state.bucketId] || BUCKET_PRESETS[DEFAULT_BUCKET_ID];
}

function createElement(tag, options = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (key === "className") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        node.dataset[dataKey] = dataValue;
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

function getText(parent, tagName) {
  return parent.getElementsByTagName(tagName)[0]?.textContent?.trim() || "";
}

function parseS3Xml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("The XML response could not be parsed.");
  }

  const errorNode = doc.getElementsByTagName("Error")[0];
  if (errorNode) {
    return {
      error: {
        code: getText(errorNode, "Code") || "S3Error",
        message: getText(errorNode, "Message") || "S3 returned an error.",
      },
    };
  }

  const root = doc.getElementsByTagName("ListBucketResult")[0];
  if (!root) {
    throw new Error("The XML did not contain a ListBucketResult.");
  }

  const contents = [...doc.getElementsByTagName("Contents")].map((node) => {
    const key = getText(node, "Key");
    const size = Number.parseInt(getText(node, "Size") || "0", 10);
    const lastModified = getText(node, "LastModified");
    const etag = getText(node, "ETag").replace(/^"|"$/g, "");
    return {
      key,
      size: Number.isFinite(size) ? size : 0,
      lastModified,
      etag,
      storageClass: getText(node, "StorageClass"),
      type: getText(node, "Type"),
      source: "snapshot",
    };
  });

  return {
    bucket: getText(root, "Name") || getActivePreset().bucketName,
    prefix: getText(root, "Prefix"),
    maxKeys: Number.parseInt(getText(root, "MaxKeys") || "0", 10),
    isTruncated: getText(root, "IsTruncated").toLowerCase() === "true",
    marker: getText(root, "Marker"),
    nextMarker: getText(root, "NextMarker"),
    contents,
  };
}

function isFolder(entry) {
  return entry.key.endsWith("/");
}

function getExtension(key) {
  const fileName = key.split("/").pop() || "";
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

function isImage(entry) {
  return IMAGE_EXTENSIONS.has(getExtension(entry.key));
}

function isPackage(entry) {
  return PACKAGE_EXTENSIONS.has(getExtension(entry.key));
}

function objectUrl(key) {
  return getActivePreset().objectBaseUrl + key.split("/").map(encodeURIComponent).join("/");
}

function formatBytes(value) {
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function shortId(value) {
  if (!value || value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function mergeEntries(entries, source) {
  const byKey = new Map(state.entries.map((entry) => [entry.key, entry]));
  for (const entry of entries) {
    if (!entry.key) {
      continue;
    }
    byKey.set(entry.key, { ...byKey.get(entry.key), ...entry, source });
  }
  state.entries = [...byKey.values()];
}

function buildAssetGroups() {
  const groups = new Map();
  const groupedKeys = new Set();

  for (const entry of state.entries) {
    if (isFolder(entry)) {
      continue;
    }

    const match = entry.key.match(COMMUNITY_ASSET_RE);
    if (!match) {
      continue;
    }

    const [, ownerId, assetId, kind, relativePath] = match;
    const groupKey = `${ownerId}/${assetId}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: groupKey,
        ownerId,
        assetId,
        files: [],
        images: [],
        packages: [],
        totalSize: 0,
        lastModified: "",
      });
    }

    const group = groups.get(groupKey);
    const enriched = { ...entry, ownerId, assetId, relativePath, extension: getExtension(entry.key) };
    group.files.push(enriched);
    group.totalSize += entry.size;
    if (!group.lastModified || new Date(entry.lastModified) > new Date(group.lastModified)) {
      group.lastModified = entry.lastModified;
    }
    if (kind === "images" && isImage(entry)) {
      group.images.push(enriched);
    }
    if (kind === "files" && isPackage(entry)) {
      group.packages.push(enriched);
    }
    groupedKeys.add(entry.key);
  }

  for (const group of groups.values()) {
    group.images.sort((a, b) => {
      const aMain = /(^|\/)main\./i.test(a.key) ? 0 : 1;
      const bMain = /(^|\/)main\./i.test(b.key) ? 0 : 1;
      return aMain - bMain || a.key.localeCompare(b.key);
    });
    group.packages.sort((a, b) => a.key.localeCompare(b.key));
  }

  return { groups: [...groups.values()], groupedKeys };
}

function getStats() {
  const files = state.entries.filter((entry) => !isFolder(entry));
  const images = files.filter(isImage);
  const packages = files.filter(isPackage);
  const { groups } = buildAssetGroups();
  return {
    objects: state.entries.length,
    files: files.length,
    images: images.length,
    packages: packages.length,
    assets: groups.length,
  };
}

function groupMatchesQuery(group, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    group.ownerId,
    group.assetId,
    group.id,
    ...group.files.map((file) => `${file.key} ${file.extension}`),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function fileMatchesQuery(file, query) {
  if (!query) {
    return true;
  }
  return `${file.key} ${getExtension(file.key)}`.toLowerCase().includes(query);
}

function compareModified(a, b) {
  return new Date(a.lastModified || 0) - new Date(b.lastModified || 0);
}

function sortFiles(files) {
  const sorted = [...files];
  sorted.sort((a, b) => {
    switch (state.sort) {
      case "modified-asc":
        return compareModified(a, b);
      case "size-desc":
        return b.size - a.size;
      case "size-asc":
        return a.size - b.size;
      case "key-asc":
        return a.key.localeCompare(b.key);
      case "type-asc":
        return getExtension(a.key).localeCompare(getExtension(b.key)) || a.key.localeCompare(b.key);
      case "modified-desc":
      default:
        return compareModified(b, a);
    }
  });
  return sorted;
}

function sortGroups(groups) {
  const sorted = [...groups];
  sorted.sort((a, b) => {
    switch (state.sort) {
      case "modified-asc":
        return compareModified(a, b);
      case "size-desc":
        return b.totalSize - a.totalSize;
      case "size-asc":
        return a.totalSize - b.totalSize;
      case "key-asc":
        return a.id.localeCompare(b.id);
      case "type-asc":
        return (a.packages[0]?.extension || "").localeCompare(b.packages[0]?.extension || "") || a.id.localeCompare(b.id);
      case "modified-desc":
      default:
        return compareModified(b, a);
    }
  });
  return sorted;
}

async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    showNotice("success", label);
  } catch {
    const input = createElement("textarea", { "aria-label": "Copy fallback" });
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showNotice("success", label);
  }
}

function linkButton(label, href) {
  return createElement(
    "a",
    {
      className: "action-button",
      href,
      target: "_blank",
      rel: "noreferrer",
      title: href,
    },
    label,
  );
}

function copyButton(label, value) {
  return createElement(
    "button",
    {
      type: "button",
      className: "action-button",
      onClick: () => copyText(value, `${label} copied`),
    },
    label,
  );
}

function createPreview(image) {
  const preview = createElement("div", { className: "asset-preview" });
  if (!image) {
    preview.append(createElement("span", { text: "No preview" }));
    return preview;
  }

  const imageNode = createElement("img", {
    src: objectUrl(image.key),
    alt: image.relativePath || image.key,
    loading: "lazy",
  });
  imageNode.addEventListener(
    "error",
    () => {
      preview.classList.add("preview-failed");
      preview.replaceChildren(createElement("span", { text: "Preview unavailable" }));
    },
    { once: true },
  );
  preview.append(imageNode);
  return preview;
}

function createMetaPill(label, value) {
  return createElement("span", { className: "pill" }, `${label}: ${value}`);
}

function createAssetCard(group) {
  const primaryImage = group.images[0];
  const packageLinks = group.packages.length
    ? group.packages
    : group.files.filter((file) => file.key.includes("/files/"));

  const title = createElement("h3", { text: shortId(group.assetId), title: group.assetId });
  const idLine = createElement("p", { className: "key-line", text: `${group.ownerId} / ${group.assetId}` });

  const meta = createElement("div", { className: "pill-row" }, [
    createMetaPill("images", group.images.length),
    createMetaPill("packages", group.packages.length),
    createMetaPill("size", formatBytes(group.totalSize)),
    createMetaPill("modified", formatDate(group.lastModified)),
  ]);

  const actions = createElement("div", { className: "actions" });
  if (primaryImage) {
    actions.append(linkButton("Open image", objectUrl(primaryImage.key)));
    actions.append(copyButton("Copy image", objectUrl(primaryImage.key)));
  }
  if (packageLinks[0]) {
    actions.append(linkButton("Open package", objectUrl(packageLinks[0].key)));
    actions.append(copyButton("Copy package", objectUrl(packageLinks[0].key)));
  }

  const packageList = createElement("div", { className: "package-list" });
  for (const file of packageLinks) {
    packageList.append(
      createElement("div", { className: "package-row" }, [
        createElement("span", { className: "file-type", text: getExtension(file.key) || "file" }),
        createElement("span", { className: "package-name", text: file.relativePath || file.key, title: file.key }),
        createElement("span", { className: "package-size", text: formatBytes(file.size) }),
      ]),
    );
  }

  const imageStrip = createElement("div", { className: "image-strip" });
  for (const image of group.images.slice(0, 4)) {
    imageStrip.append(
      createElement("img", {
        src: objectUrl(image.key),
        alt: image.relativePath,
        loading: "lazy",
        title: image.key,
      }),
    );
  }

  return createElement("article", { className: "asset-card" }, [
    createPreview(primaryImage),
    createElement("div", { className: "asset-body" }, [title, idLine, meta, packageList, imageStrip, actions]),
  ]);
}

function createFileRow(file, options = {}) {
  const ext = getExtension(file.key) || "none";
  const rowChildren = [];

  if (options.thumbnail && isImage(file)) {
    const thumb = createElement("button", {
      type: "button",
      className: "file-thumb image-open-button",
      title: `Preview ${file.key}`,
      onClick: () => openLightboxForFile(file),
    });
    const img = createElement("img", {
      src: objectUrl(file.key),
      alt: file.key,
      loading: "lazy",
    });
    img.addEventListener(
      "error",
      () => {
        thumb.classList.add("preview-failed");
        thumb.replaceChildren(createElement("span", { text: ext.toUpperCase() }));
      },
      { once: true },
    );
    thumb.append(img);
    rowChildren.push(thumb);
  }

  rowChildren.push(
    createElement("div", { className: "file-main" }, [
      createElement("p", { className: "file-key", text: file.key, title: file.key }),
      createElement("div", { className: "pill-row" }, [
        createMetaPill("type", ext),
        createMetaPill("size", formatBytes(file.size)),
        createMetaPill("modified", formatDate(file.lastModified)),
      ]),
    ]),
  );

  rowChildren.push(
    createElement("div", { className: "actions" }, [
      linkButton("Open", objectUrl(file.key)),
      copyButton("Copy", objectUrl(file.key)),
      copyButton("Copy key", file.key),
    ]),
  );

  return createElement("article", { className: options.thumbnail ? "file-row with-thumb" : "file-row" }, rowChildren);
}

function createImageCard(file) {
  const ext = getExtension(file.key) || "image";
  const preview = createElement("button", {
    type: "button",
    className: "image-card-preview",
    title: file.key,
    onClick: () => openLightboxForFile(file),
  });
  const img = createElement("img", {
    src: objectUrl(file.key),
    alt: file.key,
    loading: "lazy",
  });
  img.addEventListener(
    "error",
    () => {
      preview.classList.add("preview-failed");
      preview.replaceChildren(createElement("span", { text: "Preview unavailable" }));
    },
    { once: true },
  );
  preview.append(img);

  return createElement("article", { className: "image-card" }, [
    preview,
    createElement("div", { className: "image-card-body" }, [
      createElement("p", { className: "file-key", text: file.key, title: file.key }),
      createElement("div", { className: "pill-row" }, [
        createMetaPill("type", ext),
        createMetaPill("size", formatBytes(file.size)),
        createMetaPill("modified", formatDate(file.lastModified)),
      ]),
      createElement("div", { className: "actions" }, [
        linkButton("Open", objectUrl(file.key)),
        copyButton("Copy", objectUrl(file.key)),
        copyButton("Copy key", file.key),
      ]),
    ]),
  ]);
}

function createEmptyState() {
  return createElement("div", { className: "empty-state" }, [
    createElement("h3", { text: "No matching entries" }),
    createElement("p", { text: "Try a different query, view, or sort option." }),
  ]);
}

function showNotice(kind, message, detail = "") {
  dom.notice.hidden = false;
  dom.notice.className = `notice ${kind}`;
  dom.notice.replaceChildren(
    createElement("strong", { text: message }),
    detail ? createElement("span", { text: detail }) : "",
  );
}

function hideNotice() {
  dom.notice.hidden = true;
  dom.notice.replaceChildren();
}

function getLightboxImages() {
  const visible = getVisibleData().filter(isImage);
  if (visible.length) {
    return visible;
  }
  return sortFiles(state.entries.filter((entry) => !isFolder(entry) && isImage(entry)));
}

function updateLightbox() {
  if (!dom.lightbox || state.lightboxIndex < 0 || !state.lightboxImages.length) {
    return;
  }

  const total = state.lightboxImages.length;
  const image = state.lightboxImages[state.lightboxIndex];
  const ext = getExtension(image.key) || "image";
  dom.lightboxImage.src = objectUrl(image.key);
  dom.lightboxImage.alt = image.key;
  dom.lightboxTitle.textContent = `Image ${state.lightboxIndex + 1} of ${total}`;
  dom.lightboxMeta.textContent = `${ext.toUpperCase()} | ${formatBytes(image.size)} | ${formatDate(image.lastModified)}`;
  dom.lightboxKey.textContent = image.key;
  dom.lightboxPrev.disabled = total <= 1;
  dom.lightboxNext.disabled = total <= 1;
}

function openLightboxForFile(file) {
  const images = getLightboxImages();
  const index = images.findIndex((image) => image.key === file.key);
  state.lightboxImages = images;
  state.lightboxIndex = index >= 0 ? index : 0;
  updateLightbox();
  dom.lightbox.hidden = false;
  document.body.classList.add("modal-open");
  dom.lightboxClose.focus();
}

function closeLightbox() {
  if (!dom.lightbox || dom.lightbox.hidden) {
    return;
  }

  dom.lightbox.hidden = true;
  dom.lightboxImage.removeAttribute("src");
  state.lightboxImages = [];
  state.lightboxIndex = -1;
  if (dom.corporateDisclaimer?.hidden !== false) {
    document.body.classList.remove("modal-open");
  }
}

function stepLightbox(delta) {
  if (!state.lightboxImages.length) {
    return;
  }

  const total = state.lightboxImages.length;
  state.lightboxIndex = (state.lightboxIndex + delta + total) % total;
  updateLightbox();
}

function setupLightbox() {
  if (!dom.lightbox) {
    return;
  }

  dom.lightboxClose.addEventListener("click", closeLightbox);
  dom.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  dom.lightboxNext.addEventListener("click", () => stepLightbox(1));
  dom.lightbox.addEventListener("click", (event) => {
    if (event.target === dom.lightbox) {
      closeLightbox();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (dom.lightbox.hidden) {
      return;
    }
    if (event.key === "Escape") {
      closeLightbox();
    } else if (event.key === "ArrowLeft") {
      stepLightbox(-1);
    } else if (event.key === "ArrowRight") {
      stepLightbox(1);
    }
  });
}

function setupDisclaimer() {
  if (!dom.corporateDisclaimer || !dom.acceptDisclaimerButton) {
    return;
  }

  let accepted = false;
  try {
    accepted = localStorage.getItem(DISCLAIMER_STORAGE_KEY) === "accepted";
  } catch {
    accepted = false;
  }

  if (!accepted) {
    dom.corporateDisclaimer.hidden = false;
    document.body.classList.add("modal-open");
  }

  dom.acceptDisclaimerButton.addEventListener("click", () => {
    try {
      localStorage.setItem(DISCLAIMER_STORAGE_KEY, "accepted");
    } catch {
      // The acknowledgement still closes even when storage is unavailable.
    }
    dom.corporateDisclaimer.hidden = true;
    document.body.classList.remove("modal-open");
  });
}

function updateStats() {
  const stats = getStats();
  dom.statObjects.textContent = stats.objects.toLocaleString();
  dom.statFiles.textContent = stats.files.toLocaleString();
  dom.statImages.textContent = stats.images.toLocaleString();
  dom.statPackages.textContent = stats.packages.toLocaleString();
  dom.statAssets.textContent = stats.assets.toLocaleString();

  dom.loadNextButton.disabled = state.loadingLive || !state.nextMarker;
  dom.loadLiveButton.disabled = state.loadingLive;
}

function getVisibleData() {
  const query = state.query.trim().toLowerCase();
  const { groups, groupedKeys } = buildAssetGroups();
  const files = state.entries.filter((entry) => !isFolder(entry));

  if (state.view === "assets") {
    return sortGroups(groups.filter((group) => groupMatchesQuery(group, query)));
  }
  if (state.view === "packages") {
    return sortFiles(files.filter((file) => isPackage(file) && fileMatchesQuery(file, query)));
  }
  if (state.view === "images") {
    return sortFiles(files.filter((file) => isImage(file) && fileMatchesQuery(file, query)));
  }
  if (state.view === "ungrouped") {
    return sortFiles(files.filter((file) => !groupedKeys.has(file.key) && fileMatchesQuery(file, query)));
  }
  return sortFiles(files.filter((file) => fileMatchesQuery(file, query)));
}

function render() {
  updateStats();

  for (const button of dom.viewButtons) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
  for (const button of dom.imageLayoutButtons) {
    button.classList.toggle("active", button.dataset.imageLayout === state.imageLayout);
  }
  dom.imageLayoutControl.hidden = state.view !== "images";

  const data = getVisibleData();
  const titles = {
    assets: "Community asset groups",
    files: "All files",
    packages: "Packages and archives",
    images: "Images",
    ungrouped: "Ungrouped files",
  };
  dom.resultsTitle.textContent = titles[state.view] || "Results";
  dom.resultsCount.textContent = `${data.length.toLocaleString()} shown`;

  dom.results.className = "results";
  dom.results.replaceChildren();

  if (!data.length) {
    dom.results.classList.add("single-panel");
    dom.results.append(createEmptyState());
    return;
  }

  if (state.view === "assets") {
    dom.results.classList.add("asset-grid");
    dom.results.append(...data.map(createAssetCard));
    return;
  }

  if (state.view === "images" && state.imageLayout === "gallery") {
    dom.results.classList.add("image-gallery");
    dom.results.append(...data.map(createImageCard));
    return;
  }

  dom.results.classList.add(state.view === "images" ? "image-list" : "file-list");
  dom.results.append(...data.map((file) => createFileRow(file, { thumbnail: state.view === "images" })));
}

async function loadSnapshot(options = {}) {
  if (!getActivePreset().hasSnapshotFallback) {
    showNotice("error", "No local snapshot is available for this bucket.");
    render();
    return false;
  }

  try {
    const response = await fetch("./download.xml", { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
    }
    const parsed = parseS3Xml(text);
    if (parsed.error) {
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    }

    state.bucket = parsed.bucket || getActivePreset().bucketName;
    state.isTruncated = parsed.isTruncated;
    state.nextMarker = parsed.nextMarker;
    state.snapshotLoaded = true;
    mergeEntries(parsed.contents, "snapshot");
    showNotice(
      options.kind || "success",
      options.message || `Loaded ${parsed.contents.length.toLocaleString()} objects from download.xml.`,
      options.detail || "",
    );
    render();
    return true;
  } catch (error) {
    showNotice("error", "Could not load download.xml.", error.message);
    render();
    return false;
  }
}

async function loadLivePage(mode, options = {}) {
  if (state.loadingLive) {
    return false;
  }

  state.loadingLive = true;
  updateStats();
  const preset = getActivePreset();
  const url = new URL(preset.listEndpoint);
  url.searchParams.set("max-keys", "1000");
  if (mode === "next" && state.nextMarker) {
    url.searchParams.set("marker", state.nextMarker);
  }

  try {
    if (!options.quiet) {
      showNotice("info", mode === "next" ? "Loading next live page..." : "Loading live listing...");
    }
    const response = await fetch(url.toString(), { cache: "no-store" });
    const text = await response.text();
    const parsed = parseS3Xml(text);
    if (parsed.error) {
      throw new Error(`HTTP ${response.status} ${parsed.error.code}: ${parsed.error.message}`);
    }
    if (!response.ok) {
      throw new Error(`Live listing failed with HTTP ${response.status}.`);
    }

    state.bucket = parsed.bucket || getActivePreset().bucketName;
    state.isTruncated = parsed.isTruncated;
    state.nextMarker = parsed.nextMarker;
    state.pagesLoaded += 1;
    mergeEntries(parsed.contents, "live");
    if (!options.quiet) {
      showNotice("success", `Loaded ${parsed.contents.length.toLocaleString()} objects from the live listing.`);
    }
    return true;
  } catch (error) {
    if (options.fallbackToSnapshot && getActivePreset().hasSnapshotFallback && !state.entries.length) {
      await loadSnapshot({
        kind: "error",
        message: "Live listing failed; loaded download.xml instead.",
        detail: error.message,
      });
    } else if (options.fallbackToSnapshot && !state.entries.length) {
      showNotice("error", "Live listing did not load.", `${getActivePreset().label} has no local snapshot fallback. ${error.message}`);
    } else if (!options.quiet) {
      showNotice("error", "Live listing did not load.", error.message);
    }
    return false;
  } finally {
    state.loadingLive = false;
    render();
  }
}

function maybeLoadNextLivePage() {
  if (!state.autoLoadEnabled || state.loadingLive || !state.nextMarker || !state.pagesLoaded) {
    return;
  }
  loadLivePage("next", { quiet: true });
}

function setupInfiniteScroll() {
  if (!dom.scrollSentinel) {
    return;
  }

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          maybeLoadNextLivePage();
        }
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(dom.scrollSentinel);
    return;
  }

  window.addEventListener(
    "scroll",
    () => {
      const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      if (remaining < 1200) {
        maybeLoadNextLivePage();
      }
    },
    { passive: true },
  );
}

async function boot() {
  render();
  await loadLivePage("first", { fallbackToSnapshot: true });
}

function resetLiveData() {
  closeLightbox();
  state.entries = [];
  state.pagesLoaded = 0;
  state.snapshotLoaded = false;
  state.nextMarker = "";
  state.isTruncated = false;
  state.bucket = getActivePreset().bucketName;
}

dom.bucketSelect.addEventListener("change", () => {
  state.bucketId = dom.bucketSelect.value;
  resetLiveData();
  render();
  loadLivePage("first", { fallbackToSnapshot: true });
});

dom.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

dom.sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});

for (const button of dom.viewButtons) {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    render();
  });
}

for (const button of dom.imageLayoutButtons) {
  button.addEventListener("click", () => {
    state.imageLayout = button.dataset.imageLayout;
    render();
  });
}

dom.loadLiveButton.addEventListener("click", () => {
  resetLiveData();
  loadLivePage("first", { fallbackToSnapshot: true });
});
dom.loadNextButton.addEventListener("click", () => loadLivePage("next"));

setupDisclaimer();
setupLightbox();
setupInfiniteScroll();
boot();
