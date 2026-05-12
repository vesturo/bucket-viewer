# S3 Bucket Viewer

## Executive Summary

S3 Bucket Viewer is a static, browser-native visibility enablement experience for S3-compatible object listings. It exists to help cross-functional stakeholders inspect publicly reachable bucket index XML, associated object metadata, and image previews through a lightweight, zero-backend operational surface.

In less consultant-shaped language: it is a generic bucket listing viewer. It ships as HTML, CSS, JavaScript, and one optional XML snapshot.

## Strategic Value Proposition

- **No server-side platform footprint**: deploys cleanly to GitHub Pages without Node, containers, functions, procurement meetings, or a platform tiger team.
- **Preset-driven governance posture**: bucket endpoints are curated in code rather than accepted as arbitrary user-supplied proxy targets.
- **Public listing observability**: parses S3-compatible `ListBucketResult` XML and turns object keys, sizes, dates, images, and package-ish files into a searchable UI.
- **Stakeholder-friendly ergonomics**: includes search, sorting, bucket presets, image gallery/list views, lazy pagination, and a dark default theme for maximum dashboard credibility.
- **Continuity-aligned fallback operations**: `download.xml` remains available as a local static fallback for the `ai-space` preset.

## Bucket Presets

The app currently includes:

- `Somnium`, the default preset, included for generic-product theater and future compatibility.
- `ai-space`, a working DigitalOcean Spaces CDN endpoint with public listing and object access.

Preset configuration lives in [app.js](./app.js). Add or remove presets there when the imaginary governance council has completed its imaginary review cycle.

## Deployment Model

This project is intentionally static.

1. Commit the files to a GitHub repository.
2. Enable GitHub Pages with GitHub Actions as the source.
3. Push to `main`.
4. Let [.github/workflows/pages.yml](./.github/workflows/pages.yml) publish the root directory.

There is no build step. There is no server process. There is no runtime secret management story, which is exactly the point.

## Important Disclaimer

This viewer is intended for public, authorized, or otherwise approved bucket listings only. The presence of an index, object URL, or previewable file does not imply ownership, permission, license, endorsement, compliance approval, or a green light from Legal.

Use it for legitimate inspection, documentation, research, asset triage, and operational visibility. Do not use it to access, redistribute, automate extraction from, or otherwise mishandle systems or content you are not authorized to examine.

This project provides no warranty, no assurances, no compliance certification, no audit opinion, no incident response coverage, and no enterprise support hotline. It is a static webpage with ambitious vocabulary.
