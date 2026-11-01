#!/usr/bin/env python3
"""Stage only: immutable v6 evidence plus hash-allowlisted OCR experiments.

No commands, tests, providers, archives, or live systems are invoked. This script
intentionally cannot freeze or overwrite a final ZIP while evaluation is pending.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import zipfile


BASE_SHA256 = "2ea99e2a0b51e2c643e272d7aef750416d87cd3ef2189f943d53214df861df4a"
EXPERIMENTS = (
    "corrected-native-acceptance", "experiments", "model-evaluation",
    "glyph-experiment", "glyph-class-eng-experiment",
    "glyph-class-eng-psm13-experiment", "field-context-experiment",
    "wrong-class-controls", "native-comparison", "live-vision-dataset",
)
DEST_PREFIX = "documents/ocr-fix-20261031"
CORRECTED_TAP = DEST_PREFIX + "/corrected-native-acceptance/acceptance.tap"
FORBIDDEN_PARTS = {"node_modules", "module-copy", "__pycache__", "tmp", ".git"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(name: str) -> str:
    p = PurePosixPath(name)
    if not name or p.is_absolute() or ".." in p.parts or "\\" in name or str(p) != name:
        raise ValueError(f"unsafe evidence path: {name!r}")
    return name


def evidence(data: bytes) -> dict:
    return {"bytes": len(data), "sha256": digest(data)}


def inspect_tap(data: bytes) -> dict:
    text = data.decode("utf-8")
    if not data or len(re.findall(r"^TAP version 13$", text, re.M)) != 1:
        raise ValueError("empty or invalid TAP header")
    counts = {}
    for key in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"):
        values = re.findall(rf"^# {key} (\d+)$", text, re.M)
        if len(values) != 1:
            raise ValueError(f"incomplete/duplicate TAP {key} footer")
        counts[key] = int(values[0])
    if not re.fullmatch(r"# duration_ms [\d.]+", text.rstrip().splitlines()[-1]):
        raise ValueError("missing terminal TAP duration")
    plans = re.findall(r"^1\.\.(\d+)$", text, re.M)
    top = [int(n) for n in re.findall(r"^(?:not )?ok (\d+)(?:\s|$)", text, re.M)]
    points = re.findall(r"^\s*(?:not )?ok \d+(?:\s|$)", text, re.M)
    if len(plans) != 1 or top != list(range(1, int(plans[0]) + 1)):
        raise ValueError("TAP top-level plan/result mismatch")
    if len(points) != counts["tests"] + counts["suites"]:
        raise ValueError("TAP total result points mismatch")
    if counts["tests"] != sum(counts[k] for k in ("pass", "fail", "cancelled", "skipped", "todo")):
        raise ValueError("TAP counter arithmetic mismatch")
    return {
        "log_complete": True, "log_bytes": len(data), "log_sha256": digest(data),
        "tap_plan": int(plans[0]), "tap_result_points": len(points), "tap_counts": counts,
    }


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    with part.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(part, path)
    if path.read_bytes() != data:
        raise ValueError(f"persisted byte mismatch: {path}")


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--stage", type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    stage = (args.stage or workspace / "ocr-evidence-packaging-20261031/stage-v07-provisional").resolve()
    if stage.exists():
        raise ValueError("stage already exists; choose a new staging directory")
    base = workspace / "flycham-deployment-checks-2026-10-31.zip"
    base_bytes = base.read_bytes()
    if digest(base_bytes) != BASE_SHA256:
        raise ValueError("input is not the reviewed immutable version 6 ZIP")
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(base) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError("duplicate or damaged base archive")
        for name in names:
            safe_name(name)
            files[name] = archive.read(name)
    manifest = json.loads(files["evidence-manifest.json"])
    if set(manifest["files"]) != set(files) - {"evidence-manifest.json"}:
        raise ValueError("base manifest coverage mismatch")
    for name, recorded in manifest["files"].items():
        if evidence(files[name]) != recorded:
            raise ValueError(f"base file mismatch: {name}")
    base_taps = {name: data for name, data in files.items() if name.endswith(".tap")}
    if len(base_taps) != 428 or set(base_taps) != set(manifest["all_tap_streams"]):
        raise ValueError("base must contain exactly its indexed 428 historical TAP streams")
    for name, data in base_taps.items():
        if inspect_tap(data) != manifest["all_tap_streams"][name]:
            raise ValueError(f"base TAP evidence mismatch: {name}")
    sources = []
    for group in EXPERIMENTS:
        root = workspace / "document-ocr-fix-20261031" / group
        allow_bytes = (root / "evidence-allowlist.json").read_bytes()
        allow = json.loads(allow_bytes)
        if Path(allow["root"]).resolve() != root.resolve():
            raise ValueError(f"allowlist root mismatch: {group}")
        for name, recorded in allow["files"].items():
            safe_name(name)
            parts = PurePosixPath(name).parts
            if FORBIDDEN_PARTS.intersection(parts) or name.endswith((".traineddata", ".wasm", ".pyc")):
                raise ValueError(f"forbidden experiment payload: {group}/{name}")
            local = root / name
            if local.is_symlink() or root.resolve() not in local.resolve().parents:
                raise ValueError(f"nonlocal experiment payload: {group}/{name}")
            raw = local.read_bytes()
            if evidence(raw) != recorded:
                raise ValueError(f"allowlisted bytes changed: {group}/{name}")
            target = f"{DEST_PREFIX}/{group}/{name}"
            if target in files:
                raise ValueError(f"duplicate experiment destination: {target}")
            files[target] = raw
        files[f"{DEST_PREFIX}/{group}/evidence-allowlist.json"] = allow_bytes
        sources.append({"subdirectory": group, "files": len(allow["files"]), "allowlist_sha256": digest(allow_bytes)})
    corrected = json.loads(files[f"{DEST_PREFIX}/corrected-native-acceptance/result.json"])
    wrong_class = json.loads(files[f"{DEST_PREFIX}/wrong-class-controls/result.json"])
    corrected_tap = inspect_tap(files[CORRECTED_TAP])
    if corrected_tap["tap_counts"] != {"tests": 8, "suites": 0, "pass": 5, "fail": 3, "cancelled": 0, "skipped": 0, "todo": 0}:
        raise ValueError("corrected acceptance counters changed")
    if corrected["tapSha256"] != corrected_tap["log_sha256"] or corrected["tapBytes"] != corrected_tap["log_bytes"]:
        raise ValueError("corrected result metadata mismatch")
    if not wrong_class["falseAcceptConfirmed"] or not wrong_class["fieldContextFamilyRecommendationWithdrawn"]:
        raise ValueError("rejected prototype status changed; review required")

    erratum = {
        "kind": "historical_negative_fixture_claim_withdrawal",
        "historical_result": "documents/native-acceptance-20261031/result.json",
        "historical_tap": "documents/native-acceptance-20261031/acceptance.tap",
        "historical_tap_unchanged": True,
        "historical_framework_counts": {"tests": 8, "pass": 5, "fail": 3},
        "historical_functional_interpretation": {"positive_pdf_and_merge_passes": 4, "positive_ocr_failures": 3, "invalid_negative_control": 1},
        "old_unreadable_fixture_pixel_identical_to_clear_source": True,
        "cause": "Two Sharp resize calls were chained without materializing the 50px intermediate; only the later resize took effect.",
        "old_negative_quality_claim_withdrawn": True,
        "superseding_corrected_acceptance": f"{DEST_PREFIX}/corrected-native-acceptance/result.json",
        "corrected_framework_counts": corrected["totals"],
        "corrected_owned_child_negative_rejection_proven": True,
        "positive_ocr_failures_unresolved": 3,
        "same_eight_definitions_rerun_not_sixteen_unique_cases": True,
        "application_source_changed": False,
    }
    files["documents/native-acceptance-20261031/ERRATUM.json"] = json_bytes(erratum)
    files["documents/native-acceptance-20261031/ERRATUM-AR.md"] = """# تصحيح ملزم للاستدلال التاريخي

يُسحب الادعاء السابق بأن الشاهد القديم أثبت رفض صورة غير مقروءة. كان ملفه مطابقاً بكسلياً للصورة الواضحة: تركيب عمليتَي resize في Sharp دون إخراج الوسيط لم يُنتج تصغيراً حقيقياً. هذا عيب في أداة الاختبار الخارجية، وليس عيب مصدر تطبيق مثبتاً.

بقي سجل acceptance.tap القديم وملفات التشغيل التاريخية كما هي. نتيجة إطاره 5/8 صحيحة كسجل تنفيذ، لكن دلالتها الوظيفية: أربع حالات تحويل ودمج ناجحة، وثلاث حالات OCR إيجابية فاشلة، وشاهد سلبي قديم غير صالح للاستدلال. العبارات التاريخية المخالفة في RESULT-AR.md أو result.json مستبدلة بهذا التصحيح.

أُعيدت الحالات الثماني نفسها مرة واحدة عبر عامل التطبيق الفعلي مع شاهد مصحح ذي وسيط 50 بكسلاً مادي. النتيجة الحالية 5 نجاحات و3 إخفاقات، ونجح الرفض السلبي الصحيح. السجل الحالي في ../ocr-fix-20261031/corrected-native-acceptance/acceptance.tap. لا تُجمع المحاولتان باعتبارهما 16 حالة مستقلة، ولا تعد هذه التجارب إصلاحاً للإخفاقات الثلاث أو إثبات دقة مستندات حقيقية.
""".encode()
    summary = {
        "kind": "provisional_external_ocr_experiment_evidence_not_application_fix",
        "base_package_sha256": BASE_SHA256,
        "source_commit": manifest["commit"],
        "application_fingerprint_sha256": manifest["application_fingerprint_sha256"],
        "application_source_changed": False,
        "app_model_or_dependencies_changed": False,
        "canonical_205_file_suite_rerun": False,
        "new_canonical_test_definitions": 0,
        "historical_tap_streams_preserved": 428,
        "additional_complete_tap_streams": 1,
        "total_complete_tap_streams": 429,
        "corrected_acceptance": {"tests": 8, "pass": 5, "fail": 3, "same_definitions_rerun": True},
        "unresolved_positive_native_ocr_failures": 3,
        "old_negative_quality_claim_withdrawn": True,
        "field_context_prototype": {"initial_positive_exact": "3/3", "initial_negative_rejected": "4/4", "wrong_issuer_zero_false_accept_confirmed": True, "recommended_for_app_integration": False},
        "live_openai_evaluation": {"status": "pending_root_final_results", "included": False},
        "allowlisted_subdirectories": sources,
        "app_source_models_dependencies_included_in_added_payload": False,
        "github_support": {"ticket": 4931789, "status": "Open"},
        "remote_container_build": "blocked_by_GitHub_account_payment_or_spending_annotation; zero jobs/artifacts",
        "security_scan_started": False,
        "ready_for_deployment": False,
        "final_zip_frozen": False,
    }
    files[f"{DEST_PREFIX}/evidence-summary.json"] = json_bytes(summary)
    files[f"{DEST_PREFIX}/EXPERIMENT-SUMMARY-AR.md"] = """# ملخص تجارب OCR الخارجية — الإصلاح غير مكتمل

القبول المصحح عبر العامل الفعلي: 5/8، مع بقاء إخفاقات القراءة الإيجابية الثلاث. نجحت التحويلات والدمج والشاهد السلبي المصحح؛ لا تعديلات تطبيق أو نموذج أو اعتماديات. سُحب الادعاء السلبي القديم في ../native-acceptance-20261031/ERRATUM-AR.md، مع حفظ TAP التاريخي دون تعديل. هذه إعادة للحالات الثماني نفسها ولا تضيف تعريفات اختبار إلى الحزمة الأساسية 2568/205.

لم تُصلح المعالجة المحدودة بالنموذج الأصلي الحالات. لم تنتج مقارنات FAST/BEST/ENG الكتلة الإيجابية الكاملة المطلوبة؛ شمل التحقيق فشل تهيئة BEST الافتراضي ومقارنة SIMD ومحرك CLI محلي، بنطاقات زمن وذاكرة موثقة منفصلة. لا تنزيل أو استبدال نموذج إنتاج من هذه التجارب.

قرأت عائلة سياق حقل الوثيقة الصور الإيجابية الثلاث بدقة، ورفضت أربع صور سلبية أولية. لكن تحكماً لاحقاً طبع الرقم 0 فعلياً في بلد الإصدار؛ قرأته العائلة O وقبلته رغم نجاح أرقام التحقق. لذلك سُحبت التوصية وتوقفت الضوابط المتبقية بعد أول فشل. النجاح الأولي ليس إصلاحاً آمناً، ولا توجد رقعة تطبيق مقترحة من هذه الأدلة.

كل الإضافات ملفات أدوات وتجارب وأدلة صناعية مسموح بها ببصمات صريحة. لا تُضمّن وحدات التطبيق أو module-copy أو node_modules أو ملفات النماذج. ملفات stdout/stderr الفارغة في native-comparison مخرجات CLI مكتملة ومثبتة بالحجم؛ ليست سجلات TAP ناقصة. تحوي مجموعة live-vision-dataset بيانات صناعية وأجوبة مرجعية منفصلة؛ oracle وmetadata لا يجوز إرسالهما إلى موفر الاستدلال.

تقييم OpenAI المحدود بانتظار نتائج الوكيل الرئيسي ولم يدمج هنا بعد؛ هذا تجهيز مؤقت وليس حزمة نهائية مجمدة. تذكرة GitHub #4931789 ما زالت Open، وبناء الحاوية محجوب قبل بدء المهام، والفحص الأمني الرسمي لم يبدأ. الربط الحقيقي المعزول والنسخ والاسترجاع ودقة المستندات الحقيقية تبقى شروطاً مفتوحة قبل النشر.
""".encode()
    gates = json.loads(files["release/current-release-gates.json"])
    gates["native_document_acceptance"] = {
        "tests": 8, "pass": 5, "fail": 3, "complete_tap": True,
        "source_changed": False, "real_document_accuracy_validated": False,
        "current_evidence": f"{DEST_PREFIX}/corrected-native-acceptance/result.json",
        "old_negative_quality_claim_withdrawn": True,
        "historical_erratum": "documents/native-acceptance-20261031/ERRATUM.json",
        "same_cases_rerun_not_additional_definitions": True,
        "positive_ocr_failures_unresolved": 3,
    }
    gates["ocr_experimental_fallback"] = summary["field_context_prototype"]
    gates["live_openai_evaluation"] = summary["live_openai_evaluation"]
    gates["ocr_evidence_summary"] = f"{DEST_PREFIX}/evidence-summary.json"
    gates["ready_for_deployment"] = False
    gates["evidence_package_provisional"] = True
    gates["github_support_status"] = "Open"
    files["release/current-release-gates.json"] = json_bytes(gates)
    files["LATEST-RESULTS-AR.md"] = """# Flycham — نتائج OCR المصححة وتجهيز الأدلة، 31 أكتوبر 2026

**الإصلاح غير مكتمل والنسخة غير جاهزة للنشر. القبول المصحح عبر العامل الفعلي 5 نجاحات و3 إخفاقات من 8؛ بقيت إخفاقات OCR الإيجابية الثلاث. سُحبت توصية البديل التجريبي بعد قبول خاطئ مؤكد للحرف 0/O. هذه حزمة مؤقتة بانتظار نتائج تقييم OpenAI المحدود قبل تجميد ZIP النهائي. لم تُغير تجارب OCR مصدر التطبيق أو النموذج أو الاعتماديات.**

| الخطوة | النتيجة المثبتة | الحد العملي |
|---|---|---|
| الحزمة المحلية السابقة | 2568/2568 عبر 205 ملفات | لم تُعد في تجارب OCR؛ ليست بناء حاوية أو اختبار إنتاج |
| تكامل main والعامل عبر HTTP المحلي | 3 اختبارات مستقلة إضافية؛ السجل المشترك 50/50 يتضمن 47 ضمن الإجمالي السابق | موصلات Meta والمتصفح والبوابة وSMS صناعية؛ لا جمع مزدوج |
| قبول المستندات المصحح | 5 pass و3 fail من الحالات الثماني نفسها؛ TAP كامل | تحويل PDF والدمج والشاهد السلبي الصحيح ناجحة، وقراءات TD3 وTD1 وEXIF الإيجابية فاشلة |
| الاستدلال السلبي القديم | مسحوب؛ الشاهد كان مطابقاً بكسلياً للصورة الواضحة | بقي TAP التاريخي دون تعديل؛ لا يثبت رفض نص غير مقروء |
| عائلة سياق حقل الوثيقة | 3/3 إيجابية و4/4 سلبية أولية؛ ثم قبول خاطئ لجهة إصدار مطبوعة 0 وقراءتها O | سُحبت التوصية؛ لا دمج في التطبيق ولا إصلاح معتمد |
| النماذج والمعالجة المحلية المحدودة | لم تنتج بديلاً معتمداً للحالات الثلاث | تجارب خارج التطبيق؛ نطاقات المحرك والذاكرة موثقة منفصلة |
| تقييم OpenAI المحدود | بانتظار النتائج النهائية من الوكيل الرئيسي | غير مدمج في هذا التجهيز؛ لا ادعاء نجاح |
| بناء الحاوية | المحاولة 41165661491 توقفت startup_failure قبل أي مهمة أو artifact | قيد دفع/إنفاق GitHub؛ لا دليل على بناء من الصفر أو خطأ بيانات دفع محدد |
| دعم GitHub | #4931789 مرسلة وحالتها Open | لا دليل على رد أو رفع القيد؛ لا محاولة بناء جديدة هنا |
| الفحص الأمني الرسمي | لم يبدأ | مورد scan-prologue الإلزامي أو preflight الجاهز غير متاح |
| الربط الحقيقي والنسخ والتراجع | غير مكتملة | قراءة بيانات Meta وقبول بوابة الجسر سابقاً لا يثبت الإرسال أو التسليم أو حفظ الحالة |

سبب التصحيح في أداة العينة: تركيب resize مرتين في Sharp دون إخراج الوسيط لم ينفذ تصغيراً حقيقياً. أُخرج وسيط 50 بكسلاً مستقلاً في الاختبار المصحح، وتحقق اختلاف البكسلات ثم رفضه عامل التطبيق الفعلي دون حقول مخمنة. لا يُجمع التشغيل المصحح والسابق باعتبارهما 16 حالة مستقلة أو إضافتهما إلى 2568 اختباراً أساسياً. القياس الحالي لا يثبت دقة وثائق عملاء حقيقية أو تصنيف الأدوار تلقائياً أو التخزين الدائم أو مسار واتساب والبوابة الكامل.

نجاح أرقام تحقق MRZ لا يثبت صحة كل أحرف الأسماء والبلدان. فشل تحكم الرقم 0 المرئي هو سبب رفض العائلة التجريبية، رغم نتائجها الإيجابية الأولية. لا استبدال أحرف أو استكمال سطور أو إصلاح أرقام تحقق معتمد، ولا تعديل إنتاج مبني على تلك التجارب.

المرشح الحالي يبقى c0ae05920a71f0501b86b6258728fb138119f5ff في Draft PR #9؛ بصمة ملفات التطبيق الـ411 تبقى 65992085d4ae5ec149ef2e0770675b343f39bff38b18e74b7570c82a0e125435. بقيت الرئيسية عند e91010714290734a6fffd1fe8f9ff06be7450d31 ورعد عند abcae8218458ea6d03de82adf3c11a400120373f في الأدلة السابقة؛ لا إعادة تحقق حي أو نشر في مهمة تجميع الأدلة هذه.

محفوظة 428 سجلاً TAP سابقاً بالبايت والبصمة نفسها، وأضيف سجل قبول مصحح واحد ليصبح العدد 429. عدد السجلات يشمل محاولات تاريخية وإعادة حالات؛ لا يمثل عدد اختبارات فريدة. جميع الإضافات من قوائم سماح ببصماتها، ولا تشمل مصدر التطبيق أو وحدات منسوخة أو اعتماديات أو ملفات نموذج. ملفات مخرجات CLI الفارغة مشروعة ومختلفة عن TAP الفارغ.

التصحيح الملزم للادعاءات القديمة في documents/native-acceptance-20261031/ERRATUM-AR.md. التقرير الحالي للقبول في documents/ocr-fix-20261031/corrected-native-acceptance/README-AR.md، وملخص التجارب في documents/ocr-fix-20261031/EXPERIMENT-SUMMARY-AR.md. ملفات النتائج الأصلية تاريخية عند تعارضها مع التصحيح. تبقى release/DEPLOYMENT-ROLLBACK-PLAN-AR.md خطة غير منفذة؛ لم تُنشأ نسخة مشفرة أو يختبر الاسترجاع.

المتبقي قبل النشر: رفع قيد GitHub وبناء الحاوية من الصفر، والفحص الأمني الرسمي، والربط الحقيقي المثبت العزل، وتقييم المستندات والمحادثات الممثلة، ثم إثبات النسخ والاسترجاع ونافذة التنفيذ. لم تنفذ مهمة التجميع اتصالاً خارجياً أو رسالة عميل أو طلب تأشيرة أو دفعاً أو تغيير إعدادات النظام المباشر.
""".encode()
    files["release/prepare-ocr-evidence-package.py"] = Path(__file__).read_bytes()
    manifest = copy.deepcopy(manifest)
    manifest["all_tap_streams"][CORRECTED_TAP] = corrected_tap
    manifest["native_document_acceptance"] = gates["native_document_acceptance"]
    manifest["ocr_external_experiments"] = summary
    manifest["evidence_package_version"] = 7
    manifest["evidence_package_provisional"] = True
    manifest["live_openai_evaluation"] = summary["live_openai_evaluation"]
    manifest["ready_for_deployment"] = False
    manifest["files"] = {name: evidence(data) for name, data in sorted(files.items()) if name != "evidence-manifest.json"}
    files["evidence-manifest.json"] = json_bytes(manifest)
    taps = {name: data for name, data in files.items() if name.endswith(".tap")}
    if set(taps) != set(base_taps) | {CORRECTED_TAP} or len(taps) != 429:
        raise ValueError("unexpected added/missing TAP stream")
    for name, data in base_taps.items():
        if taps[name] != data:
            raise ValueError(f"historical TAP modified: {name}")
    stage.mkdir(parents=True)
    for name, data in sorted(files.items()):
        write(stage / name, data)
    for name, data in files.items():
        if evidence((stage / name).read_bytes()) != evidence(data):
            raise ValueError(f"staging readback failed: {name}")
    report = {
        "stage": str(stage), "files": len(files), "base_zip_sha256": BASE_SHA256,
        "preserved_tap_logs": len(base_taps), "complete_tap_logs": len(taps),
        "added_allowlisted_evidence_files": sum(row["files"] for row in sources),
        "corrected_acceptance": corrected_tap["tap_counts"],
        "provisional": True, "final_zip_created": False, "live_evaluation_pending": True,
    }
    write(stage.parent / "stage-result.json", json_bytes(report))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
