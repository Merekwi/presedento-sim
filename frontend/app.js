(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = () => window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.api;
  let currentPayload = null;
  let currentGame = null;
  let draftId = null;
  let busy = false;
  let toastTimer = null;

  const ACTIONS = {
    public_health: "Инвестиции в здравоохранение",
    education: "Реформа образования",
    infrastructure: "Национальная инфраструктурная программа",
    tax_relief: "Снижение налоговой нагрузки",
    anti_corruption: "Антикоррупционная кампания",
    defense: "Программа модернизации армии"
  };

  function toast(message) {
    const root = $("toast");
    root.textContent = message;
    root.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => root.classList.add("hidden"), 4200);
  }
  function number(value, digits = 1) {
    return Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: digits });
  }
  function money(value) {
    const n = Number(value || 0);
    if (Math.abs(n) >= 1000) return number(n / 1000, 2) + " трлн $";
    return number(n, 1) + " млрд $";
  }
  function signedMoney(value) {
    const n = Number(value || 0);
    return (n > 0 ? "+" : n < 0 ? "−" : "") + money(Math.abs(n));
  }
  function clamp(value) {
    return Math.max(0, Math.min(100, Number(value || 0)));
  }
  function dateLabel(value) {
    if (!value) return "—";
    const raw = String(value).slice(0, 10);
    const date = new Date(raw + "T12:00:00Z");
    return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  }
  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }
  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined && content !== null) el.textContent = String(content);
    return el;
  }
  function stateValue(key, fallback) {
    const value = currentGame && currentGame.state ? currentGame.state[key] : undefined;
    return value === undefined || value === null ? fallback : Number(value);
  }
  function setBar(id, value) {
    const el = $(id);
    if (el) el.style.width = clamp(value) + "%";
  }
  function renderMetrics(game) {
    const s = game.state || {};
    setText("gdp", money(s.gdp));
    setText("gdpGrowth", "Темп роста: " + (Number(s.gdpGrowth) > 0 ? "+" : "") + number(s.gdpGrowth, 2) + "%");
    setText("treasury", money(s.treasury));
    setText("budget", "Бюджетный баланс: " + signedMoney(s.budgetBalance));
    setText("inflation", number(s.inflation) + "%");
    setText("unemployment", number(s.unemployment) + "%");
    setText("approval", Math.round(Number(s.approval || 0)) + "%");
    setText("stability", Math.round(Number(s.stability || 0)) + "/100");
    setBar("approvalBar", s.approval);
    setBar("stabilityBar", s.stability);
    setText("population", number(s.population, 1) + " млн");
    setText("militaryPower", Math.round(Number(s.militaryPower || 0)) + " / 100");
    setText("debt", number(s.debt, 1) + "% ВВП");
    const services = s.publicServices ?? 58;
    const education = s.education ?? 55;
    const healthcare = s.healthcare ?? 58;
    const infrastructure = s.infrastructure ?? 52;
    const development = Math.round((clamp(services) + clamp(education) + clamp(healthcare) + clamp(infrastructure) + clamp(s.stability) + clamp(s.approval)) / 6);
    setText("developmentScore", development);
    setText("servicesValue", Math.round(clamp(services)) + "/100");
    setText("educationValue", Math.round(clamp(education)) + "/100");
    setText("healthValue", Math.round(clamp(healthcare)) + "/100");
    setText("infrastructureValue", Math.round(clamp(infrastructure)) + "/100");
    setBar("servicesBar", services);
    setBar("educationBar", education);
    setBar("healthBar", healthcare);
    setBar("infrastructureBar", infrastructure);
    const points = Math.max(0, Number(s.actionPoints ?? 2));
    setText("actionPoints", points + " / 2");
    setText("actionPointsLarge", points);
    document.querySelectorAll(".action-card").forEach(button => {
      button.disabled = points <= 0 || busy;
      button.classList.toggle("exhausted", points <= 0);
    });
  }
  function renderIdentity(game) {
    const name = game.name_local || game.name_en || game.save_name || "Государство";
    const flag = game.flag_emoji || "🏳️";
    const region = [game.region, game.government_type].filter(Boolean).join(" · ").toUpperCase();
    setText("country", name);
    setText("flag", flag);
    setText("region", region || "ГОСУДАРСТВО");
    setText("bio", game.president_name + ", " + game.president_age + " лет · " + (game.president_bio || "Президент"));
    setText("date", dateLabel(game.game_date));
    setText("term", "Месяц " + String(game.turn_number || 1).padStart(3, "0"));
    setText("topbarTurn", "Ход " + String(game.turn_number || 1).padStart(3, "0"));
    setText("sidebarTurn", "Месяц " + String(game.turn_number || 1).padStart(3, "0"));
    setText("sidebarDate", dateLabel(game.game_date));
    setText("sidebarFlag", flag);
    setText("sidebarCountry", name);
    setText("sidebarRegion", region || "Президентская республика");
    setText("mapCountryLabel", name.toLocaleUpperCase("ru-RU").slice(0, 24));
    setText("saveStatus", "Сохранено в Neon");
  }
  function renderMinisters(items) {
    const root = $("ministers");
    root.replaceChildren();
    if (!items || !items.length) {
      root.append(node("div", "loading-row", "Состав правительства не сформирован."));
      return;
    }
    items.forEach(minister => {
      const row = node("div", "minister-row");
      const initials = String(minister.full_name || "?").split(/\s+/).map(part => part[0] || "").slice(0, 2).join("").toUpperCase();
      const avatar = node("div", "minister-avatar", initials);
      const info = node("div", "minister-info");
      info.append(node("b", "", minister.full_name), node("small", "", minister.portfolio + " · Возраст " + minister.age));
      const score = node("div", "minister-score", "★ " + minister.competence);
      const dismiss = node("button", "dismiss-button", "×");
      dismiss.type = "button";
      dismiss.title = "Отправить министра в отставку";
      dismiss.dataset.dismissMinister = minister.id;
      dismiss.dataset.ministerName = minister.full_name;
      row.append(avatar, info, score, dismiss);
      root.append(row);
    });
    const select = $("ministerPortfolio");
    if (select) {
      const occupied = new Set(items.map(item => item.portfolio));
      Array.from(select.options).forEach(option => {
        option.disabled = occupied.has(option.value);
      });
      const free = Array.from(select.options).find(option => !option.disabled);
      if (free) select.value = free.value;
    }
  }
  function renderEvents(items) {
    const root = $("newsList");
    root.replaceChildren();
    if (!items || !items.length) {
      root.append(node("div", "loading-row", "События появятся после начала кампании."));
      return;
    }
    items.forEach(event => {
      const row = node("article", "event-row");
      const head = node("div", "event-row-head");
      head.append(node("span", "event-type", String(event.event_type || "СОБЫТИЕ").replaceAll("_", " ").toUpperCase()));
      const time = node("time", "", dateLabel(event.game_date));
      head.append(time);
      row.append(head, node("b", "", event.headline), node("p", "", event.article));
      root.append(row);
    });
  }
  function relationLabel(score) {
    const n = Number(score || 0);
    return n >= 50 ? "Союзные отношения" : n >= 20 ? "Партнёрские отношения" : n <= -45 ? "Кризис отношений" : n <= -15 ? "Напряжённые отношения" : "Нейтральные отношения";
  }
  function renderRelations(items) {
    const root = $("relationsList");
    root.replaceChildren();
    setText("relationCount", String((items || []).length));
    if (!items || !items.length) {
      root.append(node("div", "loading-row", "Дипломатические контакты пока не установлены."));
      return;
    }
    items.forEach(relation => {
      const row = node("div", "relation-row");
      const flag = node("div", "relation-flag", "🌐");
      const info = node("div", "relation-info");
      info.append(node("b", "", relation.other_country_name), node("small", "", relationLabel(relation.relation_score)));
      const score = node("div", "relation-score", (Number(relation.relation_score) > 0 ? "+" : "") + relation.relation_score);
      score.style.color = Number(relation.relation_score) >= 0 ? "#328b77" : "#ba6561";
      const actions = node("div", "relation-actions");
      [["summit", "Саммит"], ["trade", "Торговля"], ["sanctions", "Санкции"]].forEach(pair => {
        const button = node("button", "", pair[1]);
        button.type = "button";
        button.dataset.relationAction = pair[0];
        button.dataset.relationId = relation.id;
        button.dataset.country = relation.other_country_name;
        actions.append(button);
      });
      row.append(flag, info, score, actions);
      root.append(row);
    });
  }
  function renderUnits(items) {
    const root = $("militaryUnits");
    root.replaceChildren();
    if (!items || !items.length) {
      root.append(node("div", "loading-row", "Военные подразделения не созданы."));
      return;
    }
    items.forEach(unit => {
      const row = node("div", "unit-row");
      const icon = node("div", "unit-icon", "⬡");
      const info = node("div", "unit-info");
      info.append(node("b", "", unit.unit_type), node("small", "", number(unit.quantity, 0) + " единиц · снабжение " + unit.supply + "/100"));
      const stat = node("div", "unit-stat");
      stat.append(node("b", "", "Готовность " + unit.readiness + "%"));
      const track = node("div", "unit-track");
      const fill = node("i");
      fill.style.width = clamp(unit.readiness) + "%";
      track.append(fill);
      stat.append(track);
      row.append(icon, info, stat);
      root.append(row);
    });
  }
  function renderDecrees(items) {
    const root = $("decreeHistory");
    root.replaceChildren();
    const published = (items || []).filter(item => item.status === "published");
    if (!published.length) {
      root.append(node("div", "loading-row", "Опубликованных указов пока нет. Подготовьте первую инициативу."));
      return;
    }
    published.forEach(item => {
      const row = node("article", "decree-row");
      row.append(node("b", "", "Указ №" + item.decree_number + " · " + item.title), node("p", "", item.summary || String(item.body || "").slice(0, 200)), node("small", "", "ОПУБЛИКОВАНО"));
      root.append(row);
    });
  }
  function renderGame(payload) {
    if (!payload || !payload.game) {
      currentGame = null;
      return;
    }
    currentPayload = payload;
    currentGame = payload.game;
    renderIdentity(currentGame);
    renderMetrics(currentGame);
    renderMinisters(payload.ministers);
    renderEvents(payload.events);
    renderRelations(payload.relations);
    renderUnits(payload.units);
    renderDecrees(payload.decrees);
    setText("saveStatus", "Сохранение синхронизировано");
    $("advanceTurn").disabled = busy;
    $("newGame").disabled = busy;
  }
  async function refreshGame() {
    if (!api() || !window.PRESIDENTIAL_AUTH.user) return;
    setText("saveStatus", "Синхронизация…");
    try {
      let result = await api()("/api/presidential/game/current");
      if (!result.game) {
        const created = await api()("/api/presidential/game/new", { method: "POST", body: "{}" });
        result = await api()("/api/presidential/game/current");
        renderGame(result);
        toast("Кампания создана. Вы вступили в должность президента государства.");
        return created;
      }
      renderGame(result);
    } catch (error) {
      setText("saveStatus", "Ошибка сохранения");
      toast("Не удалось загрузить кампанию: " + error.message);
    }
  }
  async function withBusy(button, work, successMessage) {
    if (busy) return;
    busy = true;
    const previous = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.dataset.previousText = previous;
      button.textContent = "Обработка…";
    }
    document.querySelectorAll(".action-card").forEach(item => item.disabled = true);
    setText("saveStatus", "Сохранение изменений…");
    try {
      const result = await work();
      await refreshGame();
      if (successMessage) toast(typeof successMessage === "function" ? successMessage(result) : successMessage);
      return result;
    } catch (error) {
      toast("Действие не выполнено: " + error.message);
      throw error;
    } finally {
      busy = false;
      if (button) {
        button.disabled = false;
        button.textContent = previous;
      }
      if (currentGame) renderMetrics(currentGame);
      if (currentGame) {
        $("advanceTurn").disabled = false;
        $("newGame").disabled = false;
      }
    }
  }

  document.querySelectorAll(".action-card").forEach(button => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (!ACTIONS[action] || !currentGame) return;
      try {
        await withBusy(button, () => api()("/api/presidential/game/action", {
          method: "POST",
          body: JSON.stringify({ action })
        }), result => {
          const cost = result && result.cost ? " Расход казны: " + money(result.cost) + "." : "";
          return ACTIONS[action] + " утверждено." + cost;
        });
      } catch (_) {}
    });
  });

  $("advanceTurn").addEventListener("click", async () => {
    if (!currentGame) return;
    const points = Number((currentGame.state || {}).actionPoints ?? 2);
    const warning = points > 0 ? " Осталось " + points + " неиспользованных очка действий." : "";
    if (!confirm("Завершить текущий месяц и перейти к следующему? Мировое событие и экономические показатели будут пересчитаны." + warning)) return;
    try {
      await withBusy($("advanceTurn"), () => api()("/api/presidential/game/advance", { method: "POST", body: "{}" }), result => {
        return "Наступил новый месяц. " + (result.event && result.event.headline ? result.event.headline : "Экономика пересчитана.");
      });
    } catch (_) {}
  });
  $("newGame").addEventListener("click", async () => {
    if (busy) return;
    if (currentGame && !confirm("Начать новую кампанию? Текущая кампания будет переведена в завершённые.")) return;
    try {
      await withBusy($("newGame"), () => api()("/api/presidential/game/new", { method: "POST", body: "{}" }), "Новая президентская кампания началась.");
    } catch (_) {}
  });

  $("appoint").addEventListener("click", () => $("ministerDialog").showModal());
  $("cancelMinister").addEventListener("click", () => $("ministerDialog").close());
  $("ministerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = {
      action: "appoint",
      name: $("ministerName").value.trim(),
      portfolio: $("ministerPortfolio").value,
      age: Number($("ministerAge").value)
    };
    const button = event.submitter;
    try {
      await withBusy(button, () => api()("/api/presidential/game/minister", { method: "POST", body: JSON.stringify(data) }), "Министр назначен.");
      $("ministerDialog").close();
      $("ministerForm").reset();
      $("ministerAge").value = 45;
    } catch (_) {}
  });
  $("ministers").addEventListener("click", async event => {
    const button = event.target.closest("[data-dismiss-minister]");
    if (!button) return;
    const name = button.dataset.ministerName || "этого министра";
    if (!confirm("Отправить в отставку: " + name + "?")) return;
    try {
      await withBusy(button, () => api()("/api/presidential/game/minister", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss", ministerId: button.dataset.dismissMinister })
      }), name + " отправлен в отставку.");
    } catch (_) {}
  });

  $("relationsList").addEventListener("click", async event => {
    const button = event.target.closest("[data-relation-action]");
    if (!button) return;
    const action = button.dataset.relationAction;
    const country = button.dataset.country || "страну";
    const labels = { summit: "провести дипломатический саммит с ", trade: "предложить торговое соглашение ", sanctions: "ввести санкции против " };
    if (!confirm("Вы действительно хотите " + labels[action] + country + "? Действие повлияет на отношения и расходует очко действий.")) return;
    try {
      await withBusy(button, () => api()("/api/presidential/game/diplomacy", {
        method: "POST",
        body: JSON.stringify({ action, relationId: button.dataset.relationId })
      }), "Дипломатическое решение принято: " + country + ".");
    } catch (_) {}
  });

  $("openDecree").addEventListener("click", () => {
    $("decreePreview").classList.add("hidden");
    $("generate").classList.remove("hidden");
    $("decreeDialog").showModal();
  });
  $("closeDecree").addEventListener("click", () => $("decreeDialog").close());
  $("decreeForm").addEventListener("submit", async event => {
    event.preventDefault();
    const order = $("order").value.trim();
    if (order.length < 10) return toast("Опишите инициативу подробнее.");
    const button = $("generate");
    button.disabled = true;
    button.textContent = "Подготовка проекта…";
    try {
      const result = await api()("/api/presidential/game/decree/draft", { method: "POST", body: JSON.stringify({ order }) });
      const decree = result.decree;
      draftId = decree.id;
      setText("docTitle", decree.title);
      setText("decreeSummary", decree.summary || "");
      $("docBody").textContent = decree.body || "";
      $("decreePreview").classList.remove("hidden");
      button.classList.add("hidden");
      toast("Проект указа готов. Проверьте документ и опубликуйте его.");
    } catch (error) {
      toast("Не удалось подготовить указ: " + error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Подготовить проект";
    }
  });
  $("publishDecree").addEventListener("click", async () => {
    if (!draftId || busy) return;
    if (!confirm("Опубликовать указ? Он изменит показатели государства и продвинет игровой месяц.")) return;
    try {
      await withBusy($("publishDecree"), () => api()("/api/presidential/game/decree/publish", { method: "POST", body: JSON.stringify({ decreeId: draftId }) }), "Указ опубликован и сохранён.");
      draftId = null;
      $("decreeDialog").close();
    } catch (_) {}
  });
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("docTitle").textContent + "\n\n" + $("docBody").textContent);
      toast("Текст проекта скопирован.");
    } catch (_) {
      toast("Копирование недоступно в этом браузере.");
    }
  });

  document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach(item => item.classList.remove("active"));
      link.classList.add("active");
    });
  });

  window.addEventListener("presidential-auth-ready", refreshGame);
  if (window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.user) refreshGame();
})();