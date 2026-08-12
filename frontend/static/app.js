window.RemoteUI = (() => {
  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  }

  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatTime(value) {
    if (!value) {
      return "等待中";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function renderTimeline(events) {
    if (!events.length) {
      return `
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-time">等待中</div>
            <div class="timeline-summary">后端已启动，等待 `.arkpilot` 里出现可用状态。</div>
          </div>
        </div>
      `;
    }
    return events
      .map(
        (event) => `
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="timeline-time">${escapeHtml(formatTime(event.timestamp))}</div>
              <div class="timeline-kind">${escapeHtml(event.kind || "event")}</div>
              <div class="timeline-summary">${escapeHtml(event.summary || "")}</div>
            </div>
          </div>
        `
      )
      .join("");
  }

  function setChipState(element, value, fallback = "waiting") {
    if (!element) {
      return;
    }
    const normalized = String(value || fallback).toLowerCase();
    element.dataset.state = normalized;
  }

  function buildAbsoluteUrl(path) {
    if (!path) {
      return "";
    }
    return new URL(path, window.location.origin).toString();
  }

  function applyStatus(payload) {
    const statusChip = document.getElementById("run-status-chip");
    const stageChip = document.getElementById("stage-chip");
    const pollHint = document.getElementById("poll-hint");
    const workspacePath = document.getElementById("workspace-path");
    const sessionName = document.getElementById("session-name");
    const timelineList = document.getElementById("timeline-list");
    const waitingCopy = document.getElementById("waiting-copy");
    const artifactChip = document.getElementById("artifact-chip");
    const hapPath = document.getElementById("hap-path");
    const mediaPath = document.getElementById("media-path");
    const waitingState = document.getElementById("waiting-state");
    const mediaState = document.getElementById("media-state");
    const mediaImage = document.getElementById("media-image");
    const mediaVideo = document.getElementById("media-video");
    const qrPanel = document.getElementById("qr-panel");
    const qrCopy = document.getElementById("qr-copy");
    const qrPlaceholder = document.getElementById("qr-placeholder");
    const qrImage = document.getElementById("qr-image");
    const hapDownloadLink = document.getElementById("hap-download-link");
    const hapReady = Boolean(
      payload.artifacts.hap_found &&
        payload.artifacts.hap_download_path &&
        payload.artifacts.hap_qr_path
    );
    const installReady = Boolean(
      payload.artifacts.install_ready &&
        payload.artifacts.install_url &&
        payload.artifacts.install_qr_path
    );
    const distributionStatus = payload.artifacts.distribution_status || "waiting_hap";
    const qrReady = installReady;

    statusChip.textContent = payload.status || "waiting";
    stageChip.textContent = payload.stage || "waiting";
    setChipState(statusChip, payload.status);
    setChipState(stageChip, payload.stage);
    pollHint.textContent = `最近更新：${formatTime(payload.run.updated_at)}`;
    workspacePath.textContent = payload.workspace.path || "";
    sessionName.textContent = payload.tmux.session_name || "";
    timelineList.innerHTML = renderTimeline(payload.events || []);
    waitingCopy.textContent = payload.ui.waiting_message || "等待中";
    artifactChip.textContent = installReady
      ? "Install Ready"
      : distributionStatus === "packaging"
        ? "Signing"
        : hapReady
          ? "Signing"
          : "QR Waiting";
    setChipState(
      artifactChip,
      installReady
        ? "ready"
        : distributionStatus === "failed"
          ? "failed"
          : distributionStatus === "packaging"
            ? "running"
            : "waiting"
    );
    if (hapPath) {
      hapPath.textContent = payload.artifacts.hap_display_path || "未检测到";
    }
    if (mediaPath) {
      mediaPath.textContent = payload.artifacts.media_source_path || "等待生成";
    }
    if (qrPanel) {
      setChipState(
        qrPanel,
        qrReady
          ? "ready"
          : distributionStatus === "failed"
            ? "failed"
            : distributionStatus === "packaging"
              ? "running"
              : "waiting"
      );
    }
    if (installReady) {
      const installUrl = payload.artifacts.install_url;
      const qrUrl = `${payload.artifacts.install_qr_path}?t=${Date.now()}`;
      if (qrCopy) {
        qrCopy.textContent =
          "扫描二维码打开安装页，再点「立即安装」完成直装（需设备已在 Profile 白名单内）。";
      }
      if (qrPlaceholder) {
        qrPlaceholder.classList.add("hidden");
      }
      if (qrImage) {
        qrImage.classList.remove("hidden");
        if (qrImage.dataset.qrKey !== installUrl) {
          qrImage.src = qrUrl;
          qrImage.dataset.qrKey = installUrl;
        }
      }
      if (hapDownloadLink) {
        hapDownloadLink.href = installUrl;
        hapDownloadLink.textContent = "打开安装页";
        hapDownloadLink.classList.remove("hidden");
      }
    } else if (hapReady) {
      const downloadUrl = buildAbsoluteUrl(payload.artifacts.hap_download_path);
      if (qrCopy) {
        qrCopy.textContent =
          distributionStatus === "packaging"
            ? "已检测到 HAP，正在签名并生成扫码安装页。"
            : distributionStatus === "failed"
              ? `扫码安装生成失败：${payload.artifacts.distribution_error || "请查看 HPack 日志"}`
              : "已检测到 HAP，等待生成扫码安装页。";
      }
      if (qrPlaceholder) {
        qrPlaceholder.classList.remove("hidden");
      }
      if (qrImage) {
        qrImage.classList.add("hidden");
        qrImage.removeAttribute("src");
        delete qrImage.dataset.qrKey;
      }
      if (hapDownloadLink) {
        hapDownloadLink.href = downloadUrl;
        hapDownloadLink.textContent = "原始 HAP 已生成，等待签名安装页";
        hapDownloadLink.classList.remove("hidden");
      }
    } else {
      if (qrCopy) {
        qrCopy.textContent = "检测到 `.hap` 后，这里会自动签名并显示安装二维码。";
      }
      if (qrPlaceholder) {
        qrPlaceholder.classList.remove("hidden");
      }
      if (qrImage) {
        qrImage.classList.add("hidden");
        qrImage.removeAttribute("src");
        delete qrImage.dataset.qrKey;
      }
      if (hapDownloadLink) {
        hapDownloadLink.classList.add("hidden");
        hapDownloadLink.removeAttribute("href");
        hapDownloadLink.textContent = "下载原始 HAP";
      }
    }
    if (payload.artifacts.media_ready && payload.artifacts.media_path) {
      waitingState.classList.add("hidden");
      mediaState.classList.remove("hidden");
      const mediaKey = payload.artifacts.media_source_path || payload.artifacts.media_path;
      const mediaUrl = `${payload.artifacts.media_path}?t=${Date.now()}`;
      if (payload.artifacts.media_type === "mp4" || payload.artifacts.media_type === "webm") {
        mediaImage.classList.add("hidden");
        mediaVideo.classList.remove("hidden");
        if (mediaVideo.dataset.mediaKey !== mediaKey) {
          mediaVideo.src = mediaUrl;
          mediaVideo.dataset.mediaKey = mediaKey;
        }
      } else {
        mediaVideo.classList.add("hidden");
        mediaImage.classList.remove("hidden");
        if (mediaImage.dataset.mediaKey !== mediaKey) {
          mediaImage.src = mediaUrl;
          mediaImage.dataset.mediaKey = mediaKey;
        }
      }
    } else {
      mediaState.classList.add("hidden");
      waitingState.classList.remove("hidden");
    }
  }

  async function pollRun(runId, pollIntervalMs) {
    try {
      const payload = await getJson(`/api/runs/${runId}`);
      applyStatus(payload);
    } catch (error) {
      const pollHint = document.getElementById("poll-hint");
      if (pollHint) {
        pollHint.textContent = `状态获取失败：${error.message}`;
      }
    } finally {
      window.setTimeout(() => pollRun(runId, pollIntervalMs), pollIntervalMs);
    }
  }

  function initLandingPage() {
    const form = document.getElementById("create-run-form");
    if (!form) {
      return;
    }
    const promptInput = document.getElementById("prompt-input");
    const workspaceInput = document.getElementById("workspace-input");
    const planSkillInput = document.getElementById("plan-skill-input");
    const submitButton = document.getElementById("submit-button");
    const submitStatus = document.getElementById("submit-status");

    const planSkillPills = document.querySelectorAll(".plan-skill-pill");
    const handleSkillClick = (skill) => {
      planSkillPills.forEach((p) => {
        p.classList.toggle("active", p.dataset.skill === skill);
      });
      planSkillInput.value = skill;
    };
    planSkillPills.forEach((pill) => {
      pill.addEventListener("click", () => handleSkillClick(pill.dataset.skill));
    });

    const suggestChips = document.querySelectorAll(".suggest-chip");
    suggestChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const prompt = chip.dataset.prompt || "";
        if (!prompt) {
          return;
        }
        promptInput.value = prompt;
        promptInput.focus();
        promptInput.setSelectionRange(prompt.length, prompt.length);
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt) {
        submitStatus.textContent = "请输入任务描述";
        return;
      }
      submitButton.disabled = true;
      submitStatus.textContent = "正在启动本地后台...";
      try {
        const result = await postJson("/api/runs", {
          prompt,
          workspace: workspaceInput ? workspaceInput.value : "",
          plan_skill: planSkillInput ? planSkillInput.value : "",
        });
        window.location.href = result.detail_url;
      } catch (error) {
        submitStatus.textContent = `启动失败：${error.message}`;
        submitButton.disabled = false;
      }
    });
  }

  function initDetailPage() {
    const body = document.body;
    const pollIntervalMs = Number(body.dataset.pollMs || "3000");
    const runId = body.dataset.runId;
    if (!runId) {
      return;
    }
    pollRun(runId, pollIntervalMs);
  }

  return {
    initLandingPage,
    initDetailPage,
  };
})();
