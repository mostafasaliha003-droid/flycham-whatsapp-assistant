#!/usr/bin/env python3
"""Verify captured read-only MCP objects and normalize the original build logs."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def ns(value):
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z', value)
    assert match, ('TIME_FORMAT', value)
    seconds = int(datetime.datetime.fromisoformat(match[1] + '+00:00').timestamp())
    return seconds * 10**9 + int((match[2] or '').ljust(9, '0'))


def payload(path):
    value = json.loads(path.read_text())
    if 'status' in value:
        assert value['status'] == 'fulfilled'
        value = value['value']
    assert value.get('isError') is not True
    texts = [json.loads(item['text']) for item in value.get('content', []) if item.get('type') == 'text']
    result = value.get('structuredContent')
    if result is None:
        assert texts
        result = texts[0]
    assert all(text == result for text in texts), 'MCP_TEXT_STRUCTURED_MISMATCH'
    return result


def save(path, raw):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert not path.exists(), ('NO_REPLAY_OUTPUT', str(path))
    part = path.with_name(path.name + '.part')
    with part.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(part, path)
    assert path.read_bytes() == raw
    return {'bytes': len(raw), 'sha256': sha(raw)}


def check_query(query, binding, limit):
    assert set(query) == {'workspaceId', 'resource', 'type', 'direction', 'startTime', 'endTime', 'limit'}, 'QUERY_KEYS'
    assert query['workspaceId'] == binding['workspaceId'], 'QUERY_WORKSPACE'
    assert query['resource'] == [binding['serviceId']], 'QUERY_RESOURCE'
    assert query['type'] == ['build'], 'QUERY_TYPE'
    assert query['direction'] == 'forward', 'QUERY_DIRECTION'
    assert type(query['limit']) is int and query['limit'] == limit, 'QUERY_LIMIT'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collection-root', type=Path, required=True)
    args = parser.parse_args()
    root = args.collection_root.resolve(strict=True)
    binding = json.loads((root / 'terminal-binding.json').read_text())
    initial = json.loads((root / 'collection-binding.json').read_text())
    identity = ['workspaceId', 'serviceId', 'deployId', 'ciCommit', 'ciTree', 'functionalCommit',
                'functionalTree', 'applicationFingerprintSha256', 'buildNonce', 'sourceSnapshotSha256',
                'startedAt', 'finishedAt', 'startTime', 'endTime', 'finalEndTime']
    assert all(initial[key] == binding[key] for key in identity), 'COLLECTION_TERMINAL_IDENTITY'
    expected = {'workspaceId': 'tea-da8acfugekts73clvm7g', 'serviceId': 'srv-dbio8nutlv9c73b9bgbg',
                'deployId': 'dep-dbj2l20473hc73b0ks5g', 'ciCommit': '7991bf392c38689d4de8bd641a2f26b8d85d2746',
                'ciTree': '1d3511e1ac734f8ce49d8206d28a08478a7569e7',
                'functionalCommit': '46963b57c5490afcd2e9da15468cce52234f931a',
                'functionalTree': '3c67dbdd818448f102395581a8dac32004eca5d2',
                'applicationFingerprintSha256': 'a866c28ea01f64f8fdf90cb58de6953884b570bd3400d61e917eb5e74727ef5d',
                'buildNonce': 'raad-validation-20261031-v16-46963b5-01',
                'sourceSnapshotSha256': '1469392bf035bcb089711075742e9bb447952cef6d5c15da0a665d508ff2efe4'}
    assert all(binding[key] == value for key, value in expected.items()), 'EXPECTED_SOURCE_AND_SERVICE'
    assert ns(binding['startTime']) <= ns(binding['startedAt']) <= ns(binding['finishedAt']) <= ns(binding['finalEndTime']) <= ns(binding['endTime'])
    deploy = payload(root / 'raw/deploy-observation-0002.json')
    assert deploy['id'] == binding['deployId'] and deploy['commit']['id'] == binding['ciCommit'] and deploy['status'] == 'live'
    assert deploy['startedAt'] == binding['startedAt'] and deploy['finishedAt'] == binding['finishedAt']
    pages = sorted((root / 'raw').glob('mcp-build-page-*.json'))
    assert 1 <= len(pages) <= 50
    request_names = {'build-page-' + str(i).zfill(4) + '.json' for i in range(1, len(pages) + 1)} | {'final-tail-page-0001.json'}
    assert {p.name for p in (root / 'requests').iterdir() if p.is_file()} == request_names, 'EXACT_REQUEST_SET'
    raw_names = {'mcp-build-page-' + str(i).zfill(4) + '.json' for i in range(1, len(pages) + 1)} | {'final-tail-page-0001.json', 'deploy-observation-0002.json'}
    assert {p.name for p in (root / 'raw').iterdir() if p.is_file()} == raw_names, 'EXACT_RAW_SET'
    rows = []
    seen = set()
    receipts = []
    previous = None
    last_stamp = None
    limit = None
    for number, path in enumerate(pages, 1):
        assert path.name == 'mcp-build-page-' + str(number).zfill(4) + '.json'
        request_path = root / 'requests' / ('build-page-' + str(number).zfill(4) + '.json')
        query = json.loads(request_path.read_text())
        page = payload(path)
        if limit is None:
            assert type(query.get('limit')) is int and 1 <= query['limit'] <= 1000
            limit = query['limit']
        check_query(query, binding, limit)
        if previous:
            assert previous['hasMore'] is True
            assert query['startTime'] == previous['nextStartTime'] and query['endTime'] == previous['nextEndTime'], 'CURSOR_CONTINUITY'
        else:
            assert query['startTime'] == initial['startTime'] and query['endTime'] == initial['endTime']
        assert ns(binding['startTime']) <= ns(query['startTime']) <= ns(query['endTime']) <= ns(initial['endTime'])
        assert type(page['hasMore']) is bool and isinstance(page['logs'], list)
        assert len(page['logs']) <= limit
        for index, row in enumerate(page['logs']):
            assert isinstance(row['id'], str) and row['id'] not in seen, 'DUPLICATE_PROVIDER_ID'
            assert isinstance(row['message'], str)
            labels = {item['name']: item['value'] for item in row['labels']}
            assert labels['resource'] == binding['serviceId']
            if 'type' in labels:
                assert labels['type'] in {'app', 'build'}
            stamp = ns(row['timestamp'])
            assert ns(query['startTime']) <= stamp <= ns(query['endTime'])
            assert ns(binding['startTime']) <= stamp <= ns(binding['finalEndTime'])
            assert last_stamp is None or stamp >= last_stamp
            last_stamp = stamp
            seen.add(row['id'])
            rows.append({'providerId': row['id'], 'timestamp': row['timestamp'], 'message': row['message'],
                         'labels': row['labels'], 'page': number, 'rowIndex': index})
        receipts.append({'page': number, 'raw': str(path.relative_to(root)), 'rawBytes': path.stat().st_size,
                         'rawSha256': sha(path.read_bytes()), 'request': str(request_path.relative_to(root)),
                         'requestBytes': request_path.stat().st_size, 'requestSha256': sha(request_path.read_bytes()),
                         'rows': len(page['logs']), 'hasMore': page['hasMore'],
                         'nextStartTime': page['nextStartTime'], 'nextEndTime': page['nextEndTime']})
        previous = page
    assert rows and previous['hasMore'] is False
    tail_query_path = root / 'requests/final-tail-page-0001.json'
    tail_path = root / 'raw/final-tail-page-0001.json'
    tail_query = json.loads(tail_query_path.read_text())
    tail = payload(tail_path)
    check_query(tail_query, binding, limit)
    assert tail_query['startTime'] == previous['nextStartTime'] and tail_query['endTime'] == binding['finalEndTime']
    assert tail['hasMore'] is False and tail['logs'] == [], 'SCOPED_TAIL_NOT_EMPTY_EOF'
    normalized = ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows).encode()
    normalized_record = save(root / 'normalized-log-rows.jsonl', normalized)
    derived = save(root / 'build-complete-derived.log', ''.join(row['message'] + '\n' for row in rows).encode())
    result = {**expected, 'kind': 'original_container_log_recovery', 'originalBuildDateUtc': '2026-10-31',
              'recoveryDateUtc': '2026-11-01', 'newBuildRequested': False,
              'pages': receipts, 'uniqueRows': len(rows), 'pageCount': len(pages), 'paginationEof': True,
              'allInitialAndTailScopeIdentityVerified': True, 'requestLimit': limit, 'postTerminalEmptyTailEof': True,
              'terminalStatus': 'live', 'timestampOrderVerified': True, 'windowVerified': True,
              'rawToolObjectsPreserved': True, 'rawHttpTransportBytesClaimed': False,
              'providerTypeDiscrepancyPreserved': True, 'normalized': normalized_record, 'derivedLog': derived,
              'tailRawSha256': sha(tail_path.read_bytes()), 'tailRequestSha256': sha(tail_query_path.read_bytes()),
              'deployRawSha256': sha((root / 'raw/deploy-observation-0002.json').read_bytes())}
    save(root / 'pagination-and-window-receipt.json', (json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps({'rows': len(rows), 'pages': len(pages), 'scopedTailEof': True, 'newBuildRequested': False}))


if __name__ == '__main__':
    main()
