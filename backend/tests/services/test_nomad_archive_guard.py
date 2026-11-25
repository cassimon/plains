"""Tests for multi-drop archive appending and the missing-raw-file guard.

Background: every drop used to create a *new* server archive holding only that
drop's files, so a later drop replaced the archive and the metadata referenced
raw files NOMAD could not find ("…/raw/<file> is not found"). Drops now append
to one archive, and a guard verifies every referenced raw file is present
before metadata is added.
"""

import zipfile

import pytest

from app.services.nomad import (
    RawFileConflictError,
    append_files_to_zip,
    collect_referenced_raw_files,
    create_secure_zip,
    find_missing_raw_files,
)


def _archives_referencing(*names: str) -> dict:
    """Minimal generated-archives dict referencing the given raw files."""
    archives: dict = {}
    for idx, name in enumerate(names):
        archives[f"{name}.archive.yaml"] = {
            "data": {
                "m_def": "nomad_chose.schema_packages.schema_package.LabJVMeasurement",
                "jv_file": name,
                "samples": [
                    {
                        "reference": f"../upload/raw/ai03_dev{idx}_sample.archive.yaml#/data"
                    }
                ],
            }
        }
    return archives


def test_append_files_to_zip_accumulates_drops() -> None:
    zip_path = create_secure_zip(
        files=[("0001_2025-11-20_17.54.12_Stability (JV)_AI21-1C.txt", b"jv data")],
        archive_name="append_test.zip",
    )
    try:
        append_files_to_zip(zip_path, [("film1 - RawData.txt", b"uvvis data")])

        with zipfile.ZipFile(zip_path, "r") as archive:
            names = set(archive.namelist())

        # Both drops live in the one archive.
        assert "0001_2025-11-20_17.54.12_Stability (JV)_AI21-1C.txt" in names
        assert "film1 - RawData.txt" in names
    finally:
        zip_path.unlink(missing_ok=True)


def test_append_files_to_zip_deduplicates_identical_content() -> None:
    zip_path = create_secure_zip(
        files=[("data.txt", b"same")],
        archive_name="append_dedupe_test.zip",
    )
    try:
        append_files_to_zip(zip_path, [("data.txt", b"same")])

        with zipfile.ZipFile(zip_path, "r") as archive:
            assert archive.namelist().count("data.txt") == 1
            assert archive.read("data.txt") == b"same"
    finally:
        zip_path.unlink(missing_ok=True)


def test_append_files_to_zip_rejects_conflicting_content() -> None:
    zip_path = create_secure_zip(
        files=[("data.txt", b"old")],
        archive_name="append_conflict_test.zip",
    )
    try:
        with pytest.raises(RawFileConflictError) as excinfo:
            append_files_to_zip(zip_path, [("data.txt", b"new")])
        assert "data.txt" in str(excinfo.value)

        # The archive is left byte-for-byte unchanged.
        with zipfile.ZipFile(zip_path, "r") as archive:
            assert archive.namelist() == ["data.txt"]
            assert archive.read("data.txt") == b"old"
    finally:
        zip_path.unlink(missing_ok=True)


def test_append_files_to_zip_preserves_archive_after_rejection() -> None:
    """A rejected append must not modify the existing archive."""
    zip_path = create_secure_zip(
        files=[("keep.txt", b"keep"), ("data.txt", b"old")],
        archive_name="append_preserve_test.zip",
    )
    try:
        with pytest.raises(RawFileConflictError):
            append_files_to_zip(
                zip_path,
                [("new.txt", b"new"), ("data.txt", b"different")],
            )

        with zipfile.ZipFile(zip_path, "r") as archive:
            names = set(archive.namelist())
            assert names == {"keep.txt", "data.txt"}
            assert archive.read("data.txt") == b"old"
            assert "new.txt" not in names
    finally:
        zip_path.unlink(missing_ok=True)


def test_collect_referenced_raw_files_finds_quantities_and_references() -> None:
    archives = {
        "jv.archive.yaml": {"data": {"jv_file": "a JV file.txt"}},
        "stab.archive.yaml": {
            "data": {
                "stability_tracking_file": "track.txt",
                "stability_parameters_file": "params.txt",
            }
        },
        "uvvis.archive.yaml": {"data": {"uvvis_file": "film - RawData.txt"}},
        "sample.archive.yaml": {
            "data": {
                # Full raw references (images/documents) are found too …
                "images": [{"image": "../upload/raw/photo.png"}],
                # … but generated-archive cross-references are skipped.
                "cell_areas": [
                    {"reference": "../upload/raw/dev1_sample.archive.yaml#/data"}
                ],
            }
        },
    }

    referenced = collect_referenced_raw_files(archives)

    assert referenced == {
        "a JV file.txt",
        "track.txt",
        "params.txt",
        "film - RawData.txt",
        "photo.png",
    }


def test_find_missing_raw_files_flags_absent_files() -> None:
    zip_path = create_secure_zip(
        files=[("present.txt", b"x")],
        archive_name="guard_missing_test.zip",
    )
    try:
        archives = _archives_referencing("present.txt", "absent.txt")
        assert find_missing_raw_files(zip_path, archives) == ["absent.txt"]
    finally:
        zip_path.unlink(missing_ok=True)


def test_find_missing_raw_files_counts_ignored_files_as_absent() -> None:
    zip_path = create_secure_zip(
        files=[("present.txt", b"x"), ("ignored.txt", b"y")],
        archive_name="guard_ignored_test.zip",
    )
    try:
        archives = _archives_referencing("present.txt", "ignored.txt")
        missing = find_missing_raw_files(
            zip_path, archives, files_to_remove=["ignored.txt"]
        )
        assert missing == ["ignored.txt"]
    finally:
        zip_path.unlink(missing_ok=True)


def test_find_missing_raw_files_ok_when_all_present() -> None:
    zip_path = create_secure_zip(
        files=[
            ("0001_2025-11-20_17.54.12_Stability (JV)_AI21-1C.txt", b"a"),
            ("film - RawData.txt", b"b"),
        ],
        archive_name="guard_ok_test.zip",
    )
    try:
        archives = _archives_referencing(
            "0001_2025-11-20_17.54.12_Stability (JV)_AI21-1C.txt"
        )
        archives["uvvis.archive.yaml"] = {"data": {"uvvis_file": "film - RawData.txt"}}
        assert find_missing_raw_files(zip_path, archives) == []
    finally:
        zip_path.unlink(missing_ok=True)
