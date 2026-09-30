"""Lossless HDF5 -> float32 tensors for the original Keras 2.1.6 NIMA."""
import hashlib
import json
from pathlib import Path
import h5py
import numpy as np

root = Path(__file__).parent
source = root / "source-weights.hdf5"
out = root / "models" / "nima"
manifest = []
with h5py.File(source, "r") as h5, (out / "weights.bin").open("wb") as binary:
    def export(name, dataset):
        if not isinstance(dataset, h5py.Dataset):
            return
        values = np.asarray(dataset, dtype="<f4")
        manifest.append({"name": "/".join(name.split("/")[1:]).replace(":0", ""),
                         "shape": list(values.shape), "offset": binary.tell(),
                         "length": values.size})
        binary.write(values.tobytes(order="C"))
    h5.visititems(export)
    version = str(h5.attrs["keras_version"])
metadata = {
    "name": "NIMA MobileNet AVA", "kerasVersion": version,
    "architecture": "Keras 2.1.6 MobileNet v1 alpha=1, symmetric padding, GAP, Dense(10), softmax",
    "input": {"shape": [1,224,224,3], "range": [-1,1], "order": "RGB"},
    "source": "https://github.com/idealo/image-quality-assessment",
    "commit": (out / "upstream-commit.txt").read_text(encoding="utf-8-sig").strip(),
    "sourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "weightsSHA256": hashlib.sha256((out / "weights.bin").read_bytes()).hexdigest(),
    "weights": manifest
}
(out / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
print("Exported", len(manifest), "tensors;", (out / "weights.bin").stat().st_size, "bytes")
