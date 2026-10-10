"""Package the built extension and the corresponding GPL source/test files."""
import json
from pathlib import Path
import shutil
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
build = root / 'build'
version = json.loads((build / 'manifest.json').read_text())['version']
archive = root / f'LC-time-{version}.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as output:
    for source in sorted(build.rglob('*')):
        if source.is_file():
            relative = source.relative_to(build)
            if source.read_bytes() != (root / relative).read_bytes():
                raise RuntimeError(f'Build is out of date: {relative}')
            output.write(source, relative.as_posix())
    for name in ['LICENSE', 'README.md', 'TESTING.md', '安装说明.txt', 'tailwind.css', 'tailwind.config.js', 'package.json', 'yarn.lock']:
        output.write(root / name, name)
    for folder in ['scripts', 'tests']:
        for source in sorted((root / folder).rglob('*')):
            if source.is_file() and '__pycache__' not in source.parts:
                output.write(source, source.relative_to(root).as_posix())
with ZipFile(archive) as check:
    assert check.testzip() is None
    assert json.loads(check.read('manifest.json'))['version'] == version
shutil.copyfile(archive, root / 'LC-time.zip')
print(f'{archive} ({archive.stat().st_size:,} bytes)')
