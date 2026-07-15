"""LLM 精评：用 OpenAI 兼容接口的国产大模型给入围候选人重排打分。

Provider 中立 —— 任意支持 OpenAI `/chat/completions` 协议的国产模型
(DeepSeek / 通义千问 Qwen / 智谱 GLM / Kimi / 豆包 …) 都能接,只需在 .env 配:

    LLM_BASE_URL   例如 https://api.deepseek.com/v1
    LLM_API_KEY    你的 key
    LLM_MODEL      例如 deepseek-chat / qwen-plus / glm-4-flash

可选:
    LLM_TIMEOUT       单次请求超时秒数(默认 60)
    LLM_BATCH_SIZE    每次请求评多少人(默认 10)
"""

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)


class LLMConfigError(ValueError):
    pass


def _clean_env(value: str) -> str:
    return value.strip().strip("\"'")


def _cfg():
    """每次读取环境变量,便于 .env 改动后无需重启即可生效(开发期)。"""
    return {
        "base_url": _clean_env(os.environ.get("LLM_BASE_URL", "")).rstrip("/"),
        "api_key": _clean_env(os.environ.get("LLM_API_KEY", "")),
        "model": _clean_env(os.environ.get("LLM_MODEL", "")),
        "timeout": float(os.environ.get("LLM_TIMEOUT", "60")),
        "batch": int(os.environ.get("LLM_BATCH_SIZE", "10")),
    }


def is_configured() -> bool:
    c = _cfg()
    return bool(c["base_url"] and c["api_key"] and c["model"])


def config_hint() -> str:
    c = _cfg()
    missing = [k.upper() for k in ("base_url", "api_key", "model") if not c[k]]
    return "缺少环境变量: " + ", ".join("LLM_" + m for m in missing)


def _require_ascii_config(name: str, value: str) -> None:
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise LLMConfigError(
            f"{name} 包含非 ASCII 字符，请检查 backend/.env 只填写实际配置值，"
            "不要把中文说明、占位文本或行内注释写进配置；修改后需要重启后端。"
        ) from exc


def _validate_config(c: dict) -> None:
    for name, key in (
        ("LLM_BASE_URL", "base_url"),
        ("LLM_API_KEY", "api_key"),
        ("LLM_MODEL", "model"),
    ):
        _require_ascii_config(name, c[key])


def build_job_desc(job) -> str:
    """把工作台岗位字段拼成一段岗位要求描述,喂给 LLM。"""
    parts = [f"岗位名称：{job.title}"]
    if getattr(job, "department", ""):
        parts.append(f"部门：{job.department}")
    if job.experience_keywords:
        parts.append(f"经验要求关键词：{job.experience_keywords}")
    if job.capability_keywords:
        parts.append(f"能力要求关键词：{job.capability_keywords}")
    salary_min_k = getattr(job, "salary_min_k", 0) or 0
    salary_max_k = getattr(job, "salary_max_k", 0) or 0
    if salary_min_k or salary_max_k:
        parts.append(f"月薪范围：{salary_min_k or 0}-{salary_max_k or '不限'}K")
    if job.age_max and job.age_max < 99:
        parts.append(f"年龄上限：{job.age_max}岁")
    return "\n".join(parts)


SYSTEM_PROMPT = (
    "你是资深招聘顾问。请根据岗位要求，逐个评估候选人与该岗位的契合度，"
    "给出 0-100 的整数分数和一句中文理由。评分标准：90+ 高度匹配，"
    "70-89 匹配，50-69 一般，50 以下不匹配。理由要具体（点出关键匹配点或硬伤），"
    "不超过 30 字。严格只输出一个 JSON 数组，不要任何额外文字、不要 markdown 代码块。"
)


def _extract_json_array(text: str):
    """从模型输出里抠出 JSON 数组(容忍 ```json 围栏和前后多余文字)。"""
    if not text:
        return None
    # 去掉 ```json ... ``` 围栏
    fenced = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.S)
    raw = fenced.group(1) if fenced else None
    if raw is None:
        start = text.find("[")
        end = text.rfind("]")
        raw = text[start : end + 1] if (start >= 0 and end > start) else text
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else None
    except Exception:
        return None


def _call_chat(messages: list[dict]) -> str:
    """调用 OpenAI 兼容的 /chat/completions,返回 assistant 文本。"""
    c = _cfg()
    _validate_config(c)
    url = f"{c['base_url']}/chat/completions"
    headers = {
        "Authorization": f"Bearer {c['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": c["model"],
        "messages": messages,
        "temperature": 0.2,
        "stream": False,
    }
    with httpx.Client(timeout=c["timeout"]) as client:
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


def score_batch(briefs: list[dict], job_desc: str) -> dict:
    """给一批候选人打分。

    Args:
        briefs: [{id, ...其他简介字段}]，id 用于回填(建议传 candidate.id)
        job_desc: 岗位要求文本

    Returns:
        {id: {"score": int, "reason": str}}
    """
    if not briefs:
        return {}
    user = (
        f"岗位要求：\n{job_desc}\n\n"
        f"候选人列表（JSON）：\n{json.dumps(briefs, ensure_ascii=False)}\n\n"
        '请输出 JSON 数组，每个元素形如：'
        '{"id": <候选人id>, "score": <0-100整数>, "reason": "<一句话理由>"}'
    )
    content = _call_chat(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
    )
    arr = _extract_json_array(content)
    if arr is None:
        logger.warning("LLM 输出无法解析为 JSON 数组: %s", (content or "")[:200])
        return {}

    out = {}
    for item in arr:
        if not isinstance(item, dict) or "id" not in item:
            continue
        try:
            cid = item["id"]
            score = int(round(float(item.get("score", 0))))
        except (TypeError, ValueError):
            continue
        out[cid] = {
            "score": max(0, min(100, score)),
            "reason": str(item.get("reason", ""))[:120],
        }
    return out


def score_candidates(briefs: list[dict], job_desc: str) -> dict:
    """对全部入围候选人分批评分,合并结果。单批失败不影响其它批。"""
    batch = _cfg()["batch"]
    result = {}
    for i in range(0, len(briefs), batch):
        chunk = briefs[i : i + batch]
        try:
            result.update(score_batch(chunk, job_desc))
        except httpx.HTTPStatusError as e:
            logger.error("LLM 请求失败 (HTTP %s): %s", e.response.status_code, e.response.text[:200])
            raise
        except Exception as e:
            logger.error("LLM 批次评分异常: %s", e)
            raise
    return result


# ── 话术个性化：复用同一个国产 OpenAI 兼容客户端 ──────────────────────

DRAFT_SYSTEM_PROMPT = (
    "你是资深招聘 HR，正在 BOSS 直聘上给候选人发第一句打招呼。"
    "请根据候选人的经历和岗位亮点，写一句自然、真诚、不油腻、像真人说的开场白，"
    "点出这个岗位为什么适合这位候选人，引导对方回复。"
    "要求：中文，30-60 字，单独一句话不要换行；不要‘您好我是XX公司HR’这类模板开头，"
    "直接说重点；不要浮夸套话。只输出这句话本身，不要引号、不要解释。"
)


def draft_greeting(brief: dict, job_desc: str, style: str = "") -> str:
    """生成单个候选人的个性化打招呼语。

    复用 OpenAI 兼容客户端。未配置时返回空串(调用方应回退静态模板)。

    Args:
        brief: 候选人简介 dict（公司/职位/经验/技能等）
        job_desc: 岗位要求文本（可用 build_job_desc 生成）
        style: 该岗位现有话术模板，作为语气参考（可空）
    """
    if not is_configured():
        return ""
    user = (
        f"岗位要求：\n{job_desc}\n\n"
        f"候选人简介（JSON）：\n{json.dumps(brief, ensure_ascii=False)}"
    )
    if style:
        user += f"\n\n参考语气（可借鉴风格，但必须针对这位候选人重写，不要照抄）：\n{style}"
    user += "\n\n请直接输出一句打招呼语。"
    content = _call_chat(
        [
            {"role": "system", "content": DRAFT_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
    )
    text = (content or "").strip().strip('"“”\'').replace("\n", " ").strip()
    return text[:120]
