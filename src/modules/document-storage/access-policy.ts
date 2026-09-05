import type { StorageProvider } from "./model";

// Describe the provider grant, not our folder filter. New authorization models
// need separate provider and product validation before they can be offered.
export function storageAccessPolicy(provider: StorageProvider) {
  return provider === "GOOGLE_DRIVE" ? {
    mode: "GOOGLE_LEGACY_DRIVE" as const,
    newConnections: false,
    arbitraryFolderSelection: false,
    description: "Existing Google connections use a legacy permission to view and manage all Drive files. FinLynQ processes its configured Inbox and Archive, but Google does not restrict that grant to those folders.",
    limitation: "New Google connections are unavailable while folder-restricted access is resolved. Selecting a folder with Google's per-file permission does not authorize all existing or future files dropped into it.",
  } : {
    mode: "ONEDRIVE_APP_FOLDER" as const,
    newConnections: true,
    arbitraryFolderSelection: false,
    description: "Microsoft allows FinLynQ to read, create, change, and delete files within its dedicated application folder in your OneDrive. This grant covers the whole application folder, including all FinLynQ inboxes and archives there.",
    limitation: "Personal OneDrive supports this dedicated app folder. Connecting an arbitrary existing folder is not supported by this permission. A pasted sharing link does not replace the permission grant.",
  };
}
