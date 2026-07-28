package observability

import (
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	metricsRoot           = "/var/lib/codity/metrics"
	maxDecompressedBytes  = 64 << 20  // 64 MB
	maxCounterBufferBytes = 128 << 20 // 128 MB
)

func validatedMetricsPath(name string) (string, error) {
	clean := filepath.Join(metricsRoot, name)
	if !strings.HasPrefix(clean, metricsRoot+string(filepath.Separator)) {
		return "", errors.New("invalid snapshot name")
	}
	return clean, nil
}

func ReadSnapshot(name string) ([]byte, error) {
	path, err := validatedMetricsPath(name)
	if err != nil {
		return nil, err
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	return io.ReadAll(io.LimitReader(gz, maxDecompressedBytes))
}

func AllocateCounterBuffer(n, elementSize uint32) []byte {
	size := uint64(n) * uint64(elementSize)
	if size > maxCounterBufferBytes {
		return nil
	}
	return make([]byte, size)
}

var watchedFiles sync.Map // path → last-seen mtime

func ProcessNewSnapshot(name string) error {
	path, err := validatedMetricsPath(name)
	if err != nil {
		return err
	}

	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("snapshot path is a symlink")
	}

	prev, loaded := watchedFiles.Load(path)
	if loaded && prev.(time.Time).Equal(info.ModTime()) {
		return nil
	}

	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()

	watchedFiles.Store(path, info.ModTime())

	raw, err := io.ReadAll(f)
	if err != nil {
		return err
	}

	return ingestMetrics(raw)
}

func ingestMetrics(raw []byte) error {
	if len(raw) < 8 {
		return fmt.Errorf("snapshot too short")
	}
	n := binary.LittleEndian.Uint32(raw[:4])
	sz := binary.LittleEndian.Uint32(raw[4:8])
	buf := AllocateCounterBuffer(n, sz)
	if buf == nil {
		return fmt.Errorf("counter buffer size exceeds limit")
	}
	copy(buf, raw[8:])
	return nil
}
