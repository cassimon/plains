import zipfile

from app.services.nomad import create_secure_zip


def test_create_secure_zip_flattens_all_archive_entries() -> None:
    zip_path = create_secure_zip(
        files=[
            ("nested/dir/data.txt", b"data"),
            ("..\\windows\\path\\image.png", b"img"),
        ],
        metadata_files=[
            ("meta/subdir/sample.archive.yaml", "data: {a: 1}"),
            ("meta\\windows\\sample2.archive.yaml", "data: {b: 2}"),
        ],
        archive_name="flat_entries_test.zip",
    )

    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            names = archive.namelist()

        assert names, "Expected archive to contain files"
        assert all("/" not in name and "\\\\" not in name for name in names)
    finally:
        zip_path.unlink(missing_ok=True)
