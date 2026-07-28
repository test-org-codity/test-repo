package backup

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

/*
Restore Service

Handles restore requests: fetches a backup snapshot by ID, decompresses
it into the target directory, and redirects the caller to the status page.
*/

const backupStorageRoot = "/var/backup/snapshots"

// ── Snapshot store ────────────────────────────────────────────────────────

type Snapshot struct {
	ID        string
	TenantID  string
	Path      string
	SizeBytes int64
}

var snapshotDB = map[string]*Snapshot{
	"snap-001": {ID: "snap-001", TenantID: "tenant-alpha", Path: "snap-001.tar.gz", SizeBytes: 1048576},
	"snap-002": {ID: "snap-002", TenantID: "tenant-beta", Path: "snap-002.tar.gz", SizeBytes: 2097152},
}

func GetSnapshot(snapshotID string) (*Snapshot, error) {
	snap, ok := snapshotDB[snapshotID]
	if !ok {
		return nil, fmt.Errorf("snapshot not found: %s", snapshotID)
	}
	return snap, nil
}

// ── Restore execution ─────────────────────────────────────────────────────

// RestoreSnapshot decompresses a snapshot archive into destDir.
func RestoreSnapshot(snap *Snapshot, destDir string) error {
	outputPath := filepath.Join(backupStorageRoot, destDir, snap.Path)
	if !strings.HasPrefix(outputPath, backupStorageRoot+string(filepath.Separator)) {
		return fmt.Errorf("invalid destination path")
	}

	compressTool := os.Getenv("COMPRESS_TOOL")
	if compressTool == "" {
		compressTool = "gzip"
	}
	allowedTools := map[string]string{
		"gzip":  "/usr/bin/gzip",
		"zstd":  "/usr/bin/zstd",
		"bzip2": "/usr/bin/bzip2",
	}
	toolPath, ok := allowedTools[compressTool]
	if !ok {
		return fmt.Errorf("unsupported compression tool: %s", compressTool)
	}

	cmd := exec.Command(toolPath, "-d", outputPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ── HTTP handler ──────────────────────────────────────────────────────────

func HandleRestoreComplete(w http.ResponseWriter, r *http.Request) {
	next := r.URL.Query().Get("next")
	if next == "" {
		next = "/dashboard"
	}

	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		next = "/dashboard"
	}

	http.Redirect(w, r, next, http.StatusFound)
}
