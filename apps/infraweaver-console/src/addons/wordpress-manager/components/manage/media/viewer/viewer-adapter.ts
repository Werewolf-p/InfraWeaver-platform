/**
 * The CONSOLE viewer adapter — the injected data/action seam the shared viewer
 * design defines. Every verb routes through the dedicated signed-channel media route
 * (`/api/wordpress/sites/[site]/media`), so the viewer never talks to the connector
 * directly and never invents an endpoint (the signed-channel invariant). It is the
 * console twin of the plugin's admin-ajax adapter; both drive the same panel registry.
 */

import {
  fetchMediaAsset,
  fetchMediaUsage,
  postMediaWrite,
} from "../../../../lib/manage/use-media";
import type {
  MediaDeleteResponse,
  MediaEditParams,
  MediaEditResponse,
  MediaGetResponse,
  MediaProtectResponse,
  MediaUpdateMetaResponse,
  MediaUsageResponse,
} from "../../../../lib/manage/media";

/** Only the changed meta fields — mirrors the connector's "at least one" contract. */
export interface MetaFields {
  readonly alt?: string;
  readonly title?: string;
  readonly caption?: string;
  readonly description?: string;
}

export interface ViewerAdapter {
  getAsset(id: number): Promise<MediaGetResponse>;
  usage(id: number, page?: number): Promise<MediaUsageResponse>;
  updateMeta(id: number, fields: MetaFields, expectModified: string): Promise<MediaUpdateMetaResponse>;
  edit(id: number, ops: MediaEditParams["ops"], target?: "all" | "thumbnail", regenerate?: boolean): Promise<MediaEditResponse>;
  protect(ids: number[], isProtected: boolean): Promise<MediaProtectResponse>;
  del(id: number): Promise<MediaDeleteResponse>;
  assignFolder(id: number, folderId: number): Promise<unknown>;
  setTags(id: number, add: string[], remove: number[]): Promise<unknown>;
  optimize(id: number): Promise<unknown>;
  offload(id: number, op: "offload" | "unoffload"): Promise<unknown>;
  restore(id: number): Promise<unknown>;
}

/** Bind an adapter to one site. */
export function createConsoleAdapter(site: string): ViewerAdapter {
  return {
    getAsset: (id) => fetchMediaAsset(site, id),
    usage: (id, page = 1) => fetchMediaUsage(site, id, page),
    updateMeta: (id, fields, expectModified) =>
      postMediaWrite<MediaUpdateMetaResponse>(site, "updateMeta", { id, expect_modified: expectModified, ...fields }),
    edit: (id, ops, target = "all", regenerate = true) =>
      postMediaWrite<MediaEditResponse>(site, "edit", { id, ops, target, regenerate }),
    protect: (ids, isProtected) => postMediaWrite<MediaProtectResponse>(site, "protect", { ids, protected: isProtected }),
    del: (id) => postMediaWrite<MediaDeleteResponse>(site, "delete", { id, confirm: true }),
    assignFolder: (id, folderId) => postMediaWrite(site, "folder", { op: "assign", ids: [id], folder_id: folderId }),
    setTags: (id, add, remove) =>
      postMediaWrite(site, "folder", { op: "tag", ids: [id], ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) }),
    optimize: (id) => postMediaWrite(site, "optimize", { ids: [id] }),
    offload: (id, op) => postMediaWrite(site, "offload", { op, ids: [id] }),
    restore: (id) => postMediaWrite(site, "restore", { ids: [id] }),
  };
}
