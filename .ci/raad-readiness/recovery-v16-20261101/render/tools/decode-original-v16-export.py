#!/usr/bin/env python3
"""Offline, bounded decoding of test-only Render MCP log evidence. No network."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import traceback
import zlib

TAG = 'RAAD_MAIN_NODE26_EVIDENCE'
COMMIT = '46963b57c5490afcd2e9da15468cce52234f931a'
TREE = '3c67dbdd818448f102395581a8dac32004eca5d2'
FINGERPRINT = 'a866c28ea01f64f8fdf90cb58de6953884b570bd3400d61e917eb5e74727ef5d'
NONCE = 'raad-validation-20261031-v16-46963b5-01'
MAX_COMPRESSED = 262144
MAX_TAR = 16 * 1024 * 1024
MAX_MEMBER = 2 * 1024 * 1024
ALLOWED = {
    'install/npm-install.log', 'install/result.json',
    'baseline/native-probe.log', 'baseline/step.json', 'baseline/result.json',
    'profile-controls/test.log', 'profile-controls/result.json',
    'startup-driver.log', 'startup-step.json', 'startup/native-smoke.log',
    'startup/npm-start.log', 'startup/fence-events.jsonl',
    'startup/blocked-attempts.jsonl', 'startup/result.json',
    'pdf/native-probe.log', 'pdf/step.json', 'pdf/result.json',
    'build-provenance.json', 'result.json', 'evidence-index.json',
    'failure-traceback.log', 'failure.json',
}
SUCCESS_REQUIRED = ALLOWED - {
    'startup/blocked-attempts.jsonl', 'failure-traceback.log', 'failure.json'}
META_KEYS = {'tag', 'event', 'success', 'encoding', 'chunks', 'gzipBytes',
             'encodedBytes', 'sha256', 'functionalCommit', 'buildNonce'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def durable(path, raw):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.part')
    with temporary.open('xb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    assert path.read_bytes() == raw


def dump(path, value):
    durable(path, (json.dumps(value, indent=2) + '\n').encode())


def typed_integer(value, low, high):
    return type(value) is int and low <= value <= high


def events_from_logs(rows):
    result = []
    decoder = json.JSONDecoder()
    for row in rows:
        message = row['message']
        assert isinstance(message, str)
        for line in message.splitlines():
            clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)
            match = re.search(r'\{(?=\s*"tag"\s*:\s*"' + TAG + r'")', clean)
            if not match:
                continue
            event, end = decoder.raw_decode(clean, match.start())
            assert not clean[end:].strip(), 'TRAILING_EXPORT_RECORD_DATA'
            result.append({'record': event, 'providerId': row.get('providerId'),
                           'timestamp': row.get('timestamp'), 'page': row.get('page')})
    return result


def decode_transport(records):
    assert records, 'EXPORT_NOT_FOUND'
    begins = [row for row in records if row['record'].get('event') == 'begin']
    ends = [row for row in records if row['record'].get('event') == 'end']
    assert len(begins) == len(ends) == 1, 'AMBIGUOUS_OR_INCOMPLETE_EXPORT_ENVELOPE'
    first = begins[0]['record']; last = ends[0]['record']
    assert set(first) == META_KEYS and set(last) == META_KEYS | {'eof'}
    assert records[0] is begins[0] and records[-1] is ends[0], 'EXPORT_ORDER'
    assert first['tag'] == TAG and first['event'] == 'begin'
    assert type(first['success']) is bool
    assert first['encoding'] == 'base64+gzip+tar'
    assert first['functionalCommit'] == COMMIT and first['buildNonce'] == NONCE
    assert typed_integer(first['chunks'], 1, 342)
    assert typed_integer(first['gzipBytes'], 1, MAX_COMPRESSED)
    assert typed_integer(first['encodedBytes'], 4, 349528)
    assert re.fullmatch(r'[a-f0-9]{64}', first['sha256'])
    assert last['eof'] is True and last['event'] == 'end'
    assert {**last, 'event': 'begin'} == {**first, 'eof': True}, 'ENVELOPE_METADATA_MISMATCH'
    pieces = records[1:-1]
    assert len(pieces) == first['chunks'], 'CHUNK_COUNT'
    encoded = []
    for expected, row in enumerate(pieces, 1):
        item = row['record']
        assert set(item) == {'tag', 'event', 'index', 'data'}
        assert item['tag'] == TAG and item['event'] == 'chunk'
        assert type(item['index']) is int and item['index'] == expected, 'CHUNK_CONTIGUITY'
        assert isinstance(item['data'], str) and item['data'].isascii()
        assert 1 <= len(item['data']) <= 1024
        assert expected == len(pieces) or len(item['data']) == 1024
        encoded.append(item['data'])
    encoded = ''.join(encoded)
    assert len(encoded) == first['encodedBytes']
    compressed = base64.b64decode(encoded, validate=True)
    assert base64.b64encode(compressed).decode('ascii') == encoded
    assert len(compressed) == first['gzipBytes'] and digest(compressed) == first['sha256']
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    archive = inflater.decompress(compressed, MAX_TAR + 1)
    assert len(archive) <= MAX_TAR and not inflater.unconsumed_tail
    archive += inflater.flush(MAX_TAR + 1 - len(archive))
    assert len(archive) <= MAX_TAR and inflater.eof and not inflater.unused_data
    return first, compressed, archive


def archive_members(raw):
    assert len(raw) % 512 == 0
    offset = 0; files = {}; eof = False
    while offset < len(raw):
        block = raw[offset:offset + 512]
        if block == bytes(512):
            assert len(raw) - offset >= 1024 and raw[offset:] == bytes(len(raw) - offset)
            eof = True; break
        member = tarfile.TarInfo.frombuf(block, 'utf-8', 'strict')
        name = member.name; relative = PurePosixPath(name)
        assert member.type in {tarfile.REGTYPE, tarfile.AREGTYPE}, 'NONREGULAR_ARCHIVE_MEMBER'
        assert not member.linkname and not member.pax_headers
        assert name in ALLOWED and name not in files, 'FORBIDDEN_OR_DUPLICATE_ARCHIVE_PATH'
        assert not relative.is_absolute() and '\\' not in name and '\x00' not in name
        assert relative.as_posix() == name and all(part not in {'.', '..', ''} for part in relative.parts)
        assert typed_integer(member.size, 0, MAX_MEMBER)
        assert member.mode == 0o600
        begin = offset + 512; end = begin + member.size
        padded = end + ((512 - member.size % 512) % 512)
        assert padded <= len(raw) and raw[end:padded] == bytes(padded - end)
        files[name] = raw[begin:end]; offset = padded
        assert len(files) <= len(ALLOWED)
    assert eof and 'evidence-index.json' in files
    index = json.loads(files['evidence-index.json'])
    assert set(index) == {'files', 'selfExcluded'} and index['selfExcluded'] is True
    assert set(index['files']) == set(files) - {'evidence-index.json'}, 'INDEX_PATH_SET'
    for name, record in index['files'].items():
        assert set(record) == {'bytes', 'sha256'}
        assert type(record['bytes']) is int and record['bytes'] == len(files[name])
        assert record['sha256'] == digest(files[name]), 'INDEX_MEMBER_DIGEST'
    return files


def validate_artifacts(meta, files):
    if not meta['success']:
        assert {'failure.json', 'failure-traceback.log'} <= set(files)
        assert json.loads(files['failure.json'])['success'] is False
        return {'buildEvidenceSuccess': False, 'completeFailureEvidence': True,
                'independentResultBinding': False}
    assert SUCCESS_REQUIRED <= set(files)
    provenance = json.loads(files['build-provenance.json'])
    result = json.loads(files['result.json'])
    for item in [provenance, result]:
        assert item['functionalCommit'] == COMMIT and item['functionalTree'] == TREE
        assert item['applicationFingerprintSha256'] == FINGERPRINT and item['buildNonce'] == NONCE
    assert result['success'] is True and result['fullSuiteRerun'] is False
    assert result['releaseReady'] is False and result['liveActions'] == 0
    return {'buildEvidenceSuccess': True, 'independentResultBinding': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--normalized-logs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        rows = [json.loads(line) for line in args.normalized_logs.read_text().splitlines()]
        records = events_from_logs(rows)
        meta, compressed, archive = decode_transport(records)
        files = archive_members(archive)
        status = validate_artifacts(meta, files)
        # All payload paths and hashes are validated in memory before any member
        # is materialized; never use tar.extractall or follow archive links.
        for name, raw in files.items():
            durable(args.output / 'private-artifacts' / name, raw)
        durable(args.output / 'transport-archive.tar.gz', compressed)
        dump(args.output / 'transport-records.json', records)
        dump(args.output / 'member-index.json', {'files': {
            name: {'bytes': len(raw), 'sha256': digest(raw)} for name, raw in files.items()}})
        dump(args.output / 'collector-result.json', {
            'transportVerified': True, **status, 'functionalCommit': COMMIT,
            'functionalTree': TREE, 'applicationFingerprintSha256': FINGERPRINT,
            'buildNonce': NONCE, 'beginEndEofVerified': True,
            'contiguousChunksVerified': meta['chunks'], 'gzipBytes': len(compressed),
            'gzipSha256': digest(compressed), 'tarBytes': len(archive),
            'archiveMembersVerified': len(files), 'everyMemberReadbackVerified': True,
            'noSourceDependenciesModelStateCredentialsMaterialized': True,
            'providerPaginationEofVerifiedByThisDecoder': False,
            'terminalProviderDeployVerifiedByThisDecoder': False})
    except Exception:
        durable(args.output / 'collector-failure-traceback.log', traceback.format_exc().encode())
        dump(args.output / 'collector-result.json', {'transportVerified': False,
             'buildEvidenceSuccess': False, 'failurePreserved': True})
        raise


if __name__ == '__main__':
    main()
