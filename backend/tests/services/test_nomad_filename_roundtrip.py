"""The name a file gets inside the upload zip must equal the name the generated
archive YAML points at.

When they diverged, NOMAD's parser failed with a message that named a file which
looked perfectly present in the upload:

    LabJVMeasurement: could not parse 0001_..._Stability (JV)_AI03-1A.txt:
    [Errno 2] No such file or directory: '.../raw/0001_..._Stability (JV)_AI03-1A.txt'

because create_secure_zip had silently dropped the parentheses from the entry.
"""

import uuid
import zipfile
from types import SimpleNamespace

from app.services.nomad import (
    create_nomad_metadata_yaml,
    create_secure_zip,
    sanitize_upload_filename,
)

# The filename from the field report: parentheses, spaces, dots.
JV_FILENAME = "0001_2025-11-19_21.15.49_Stability (JV)_AI03-1A.txt"


def test_parentheses_and_spaces_survive_the_zip() -> None:
    zip_path = create_secure_zip(
        files=[(JV_FILENAME, b"voltage,current\n")],
        archive_name="paren_roundtrip_test.zip",
    )
    try:
        with zipfile.ZipFile(zip_path) as archive:
            assert archive.namelist() == [JV_FILENAME]
    finally:
        zip_path.unlink(missing_ok=True)


def test_sanitizer_is_identity_for_ordinary_measurement_names() -> None:
    assert sanitize_upload_filename(JV_FILENAME) == JV_FILENAME


def test_sanitizer_still_flattens_paths_and_strips_traversal() -> None:
    assert sanitize_upload_filename("../../../etc/passwd") == "passwd"
    assert sanitize_upload_filename("..\\windows\\path\\image.png") == "image.png"
    assert sanitize_upload_filename("nested/dir/data.txt") == "data.txt"
    assert "\x00" not in sanitize_upload_filename("evil\x00.txt")


def test_zip_entry_matches_the_name_the_metadata_points_at() -> None:
    """The invariant the bug broke: whatever we write, we must reference."""
    weird = 'raw/od d:name*?"<>|(JV) file.txt'
    entry_name = sanitize_upload_filename(weird)

    zip_path = create_secure_zip(
        files=[(weird, b"x")], archive_name="invariant_test.zip"
    )
    try:
        with zipfile.ZipFile(zip_path) as archive:
            assert archive.namelist() == [entry_name]
        assert "/" not in entry_name and "\\" not in entry_name
    finally:
        zip_path.unlink(missing_ok=True)


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value


class _FakeSession:
    def __init__(self, values):
        self._values = iter(values)

    def exec(self, _statement):
        return _FakeResult(next(self._values))


def test_generated_jv_archive_points_at_the_file_the_zip_actually_contains() -> None:
    """End to end: the `jv_file` the parser resolves == the zip entry we ship."""
    experiment_id = str(uuid.uuid4())
    experiment_orm = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=uuid.uuid4(),
        process_id=None,
        name="E",
        description="",
        architecture="n-i-p",
        substrate_material="Glass",
        devices_per_substrate=1,
        device_area=0.09,
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [{"id": "sub-1", "name": "AI03-1A"}],
    }
    # Measurement archives are generated from the device groups' files.
    measurement_file = {
        "fileName": JV_FILENAME,
        "fileType": "Stability (JV)",  # → LabJVMeasurement, as in the report
        "user": "Tester",
    }
    device_groups = [
        {
            "id": "grp-1",
            "deviceName": "AI03-1A device 1",
            "assignedSubstrateId": "sub-1",
            "files": [measurement_file],
        }
    ]

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_FakeSession([experiment_orm, [], []]),
        experiment_snapshot=experiment_snapshot,
        process_snapshot={
            "id": "p",
            "name": "P",
            "stages": [],
            "generatedStacks": [],
        },
        measurement_files=[measurement_file],
        device_groups=device_groups,
    )

    jv_archives = [
        a["data"]
        for a in archives.values()
        if "LabJVMeasurement" in str(a.get("data", {}).get("m_def", ""))
    ]
    assert jv_archives, "expected a LabJVMeasurement archive to be generated"
    referenced = jv_archives[0]["jv_file"]

    zip_path = create_secure_zip(
        files=[(JV_FILENAME, b"voltage,current\n")],
        archive_name="jv_e2e_test.zip",
    )
    try:
        with zipfile.ZipFile(zip_path) as archive:
            entries = archive.namelist()
    finally:
        zip_path.unlink(missing_ok=True)

    # This is the assertion that would have caught the reported parse failure.
    assert referenced in entries, (
        f"metadata points at {referenced!r} but the upload contains {entries!r}"
    )
