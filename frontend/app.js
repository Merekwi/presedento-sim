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

  const ISO_NUMERIC = {
    AR:"032",AU:"036",BR:"076",CA:"124",CL:"152",EG:"818",FR:"250",DE:"276",IN:"356",ID:"360",
    JP:"392",KE:"404",MX:"484",NL:"528",NO:"578",PL:"616",ZA:"710",TH:"764",TR:"792",UA:"804"
  };
  let setupCountries = [];
  let selectedCountryId = null;
  let selectedPortrait = "p01";
  let worldTopologyPromise = null;

  function sprite(file, symbol, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", file === "flags.svg" ? "0 0 60 40" : "0 0 96 112");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    const href = "./assets/" + file + "#" + symbol;
    use.setAttribute("href", href);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    svg.append(use);
    return svg;
  }
  function putFlag(id, iso2, fallback) {
    const root = $(id);
    if (!root) return;
    root.replaceChildren();
    if (iso2) root.append(sprite("flags.svg", "flag-" + iso2, "flag-svg"));
    else root.textContent = fallback || "🏳️";
  }
  function portraitIdFromName(name) {
    let hash = 0;
    for (const ch of String(name || "")) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
    return "p" + String((hash % 16) + 1).padStart(2, "0");
  }
  function portraitNode(id, className) {
    return sprite("portraits.svg", /^p(0[1-9]|1[0-6])$/.test(id || "") ? id : "p01", className || "portrait-svg");
  }
  function countryLabel(country) {
    return country.name_local || country.name_en || "Государство";
  }
  function formatCountryMetric(value, suffix) {
    return Number(value || 0).toLocaleString("ru-RU", {maximumFractionDigits:1}) + (suffix || "");
  }
  function renderCountryGrid() {
    const root = $("countryGrid");
    if (!root) return;
    root.replaceChildren();
    const query = String($("countrySearch").value || "").trim().toLocaleLowerCase("ru-RU");
    const countries = setupCountries.filter(country => {
      return [countryLabel(country), country.name_en, country.region, country.iso2].some(value => String(value || "").toLocaleLowerCase("ru-RU").includes(query));
    });
    if (!countries.length) {
      root.append(node("div", "loading-row", "Страна не найдена."));
      return;
    }
    countries.forEach(country => {
      const button = node("button", "country-option" + (String(country.id) === String(selectedCountryId) ? " selected" : ""));
      button.type = "button";
      button.dataset.countryId = country.id;
      button.append(sprite("flags.svg", "flag-" + country.iso2, "flag-svg"));
      const copy = node("span", "country-option-copy");
      copy.append(node("b", "", countryLabel(country)), node("small", "", country.region || country.government_type || ""));
      button.append(copy);
      button.append(node("span", "country-option-check", String(country.iso2 || "").toUpperCase()));
      root.append(button);
    });
    setText("setupSelectionStatus", selectedCountryId ? "Выбрано: " + countryLabel(setupCountries.find(item => String(item.id) === String(selectedCountryId))) : "Сначала выберите государство");
    $("startCampaign").disabled = !selectedCountryId;
  }
  function selectCountry(id) {
    selectedCountryId = String(id);
    const country = setupCountries.find(item => String(item.id) === selectedCountryId);
    if (!country) return;
    const baseline = country.baseline_state || {};
    const preview = $("countryPreview");
    preview.replaceChildren();
    const head = node("div", "country-preview-head");
    head.append(sprite("flags.svg", "flag-" + country.iso2, "flag-svg"), node("div", "", countryLabel(country)));
    preview.append(head);
    const facts = node("div", "country-preview-facts");
    [
      ["ВВП", formatCountryMetric(baseline.gdp, " млрд $")],
      ["Население", formatCountryMetric(baseline.population, " млн")],
      ["Безработица", formatCountryMetric(baseline.unemployment, "%")],
      ["Инфляция", formatCountryMetric(baseline.inflation, "%")]
    ].forEach(pair => {
      const item = node("div", "");
      item.append(node("small", "", pair[0]), node("b", "", pair[1]));
      facts.append(item);
    });
    preview.append(facts, node("span", "country-preview-government", country.government_type || country.region || ""));
    renderCountryGrid();
  }
  async function openSetup() {
    if (busy || !api()) return;
    try {
      const result = await api()("/api/presidential/game/setup");
      setupCountries = Array.isArray(result.countries) ? result.countries : [];
      selectedCountryId = null;
      selectedPortrait = "p01";
      $("countrySearch").value = "";
      $("countryPreview").replaceChildren(node("b", "", "Страна ещё не выбрана"), node("span", "", "Выберите государство, чтобы увидеть его стартовые показатели."));
      $("portraitGrid").replaceChildren();
      for (let i = 1; i <= 16; i++) {
        const id = "p" + String(i).padStart(2, "0");
        const button = node("button", "portrait-choice" + (id === selectedPortrait ? " selected" : ""));
        button.type = "button";
        button.dataset.portrait = id;
        button.title = "Портрет " + i;
        button.append(portraitNode(id, "portrait-svg"));
        $("portraitGrid").append(button);
      }
      const userName = window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.user && window.PRESIDENTIAL_AUTH.user.firstName;
      $("presidentName").value = userName ? String(userName).slice(0, 80) : "";
      $("presidentAge").value = "45";
      $("campaignTitle").value = "";
      $("politicalCourse").value = "social_democracy";
      $("difficulty").value = "normal";
      $("startYear").value = "2026";
      renderCountryGrid();
      $("setupDialog").showModal();
    } catch (error) {
      toast("Не удалось загрузить каталог стран: " + error.message);
    }
  }
  function loadWorldTopology() {
    if (!worldTopologyPromise) {
      worldTopologyPromise = fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json")
        .then(response => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        });
    }
    return worldTopologyPromise;
  }
  async function renderWorldMap(iso2) {
    const root = $("worldMap");
    if (!root || !window.topojson || !window.d3) return;
    try {
      const topology = await loadWorldTopology();
      const features = window.topojson.feature(topology, topology.objects.countries).features;
      const width = 820, height = 340;
      const collection = {type:"FeatureCollection",features};
      const projection = window.d3.geoNaturalEarth1().fitExtent([[10,10],[width-10,height-10]], collection);
      const path = window.d3.geoPath(projection);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "world-map-svg");
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Карта мира с реальными границами стран");
      const activeId = ISO_NUMERIC[iso2] || "";
      features.forEach(feature => {
        const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
        shape.setAttribute("d", path(feature));
        shape.setAttribute("class", "map-country" + (String(feature.id).padStart(3,"0") === activeId ? " active" : ""));
        shape.setAttribute("data-country", feature.properties && feature.properties.name ? feature.properties.name : "");
        shape.setAttribute("tabindex", "0");
        shape.setAttribute("aria-label", feature.properties && feature.properties.name ? feature.properties.name : "Страна");
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = shape.getAttribute("aria-label");
        shape.append(title);
        svg.append(shape);
      });
      root.replaceChildren(svg);
    } catch (_) {
      root.replaceChildren(node("div", "map-loading", "Не удалось загрузить географические данные. Проверьте подключение к сети."));
    }
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
    putFlag("flag", game.iso2, flag);
    putFlag("sidebarFlag", game.iso2, flag);
    setText("region", region || "ГОСУДАРСТВО");
    setText("bio", game.president_name + ", " + game.president_age + " лет · " + (game.president_bio || "Президент"));
    setText("date", dateLabel(game.game_date));
    setText("term", "Месяц " + String(game.turn_number || 1).padStart(3, "0"));
    setText("topbarTurn", "Ход " + String(game.turn_number || 1).padStart(3, "0"));
    setText("sidebarTurn", "Месяц " + String(game.turn_number || 1).padStart(3, "0"));
    setText("sidebarDate", dateLabel(game.game_date));
    setText("sidebarCountry", name);
    setText("sidebarRegion", region || "Президентская республика");
    setText("mapCountryLabel", name.toLocaleUpperCase("ru-RU").slice(0, 24));
    renderWorldMap(game.iso2);
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
      const avatar = node("div", "minister-avatar");
      const traits = minister.traits && typeof minister.traits === "object" ? minister.traits : {};
      avatar.append(portraitNode(traits.portraitId || portraitIdFromName(minister.full_name), "portrait-svg"));
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
        currentGame = null;
        await openSetup();
        return;
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
    const keepCardContents = !!(button && button.classList.contains("action-card"));
    if (button) {
      button.disabled = true;
      button.dataset.previousText = previous;
      if (!keepCardContents) button.textContent = "Обработка…";
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
        if (!keepCardContents) button.textContent = previous;
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
  $("newGame").addEventListener("click", () => openSetup());
  $("closeSetup").addEventListener("click", () => $("setupDialog").close());
  $("cancelSetup").addEventListener("click", () => $("setupDialog").close());
  $("countrySearch").addEventListener("input", renderCountryGrid);
  $("countryGrid").addEventListener("click", event => {
    const button = event.target.closest("[data-country-id]");
    if (button) selectCountry(button.dataset.countryId);
  });
  $("portraitGrid").addEventListener("click", event => {
    const button = event.target.closest("[data-portrait]");
    if (!button) return;
    selectedPortrait = button.dataset.portrait;
    document.querySelectorAll(".portrait-choice").forEach(item => item.classList.toggle("selected", item.dataset.portrait === selectedPortrait));
  });
  $("setupForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!selectedCountryId) return toast("Сначала выберите государство.");
    const presidentName = $("presidentName").value.trim();
    const presidentAge = Number($("presidentAge").value);
    if (presidentName.length < 3 || !Number.isInteger(presidentAge) || presidentAge < 25 || presidentAge > 90) return toast("Проверьте имя и возраст президента.");
    if (currentGame && !confirm("Начать новую кампанию? Текущее сохранение будет завершено, а выбранное государство станет новой кампанией.")) return;
    const payload = {
      countryId: Number(selectedCountryId), presidentName, presidentAge,
      campaignTitle: $("campaignTitle").value.trim(),
      politicalCourse: $("politicalCourse").value,
      difficulty: $("difficulty").value,
      startYear: Number($("startYear").value),
      portraitId: selectedPortrait
    };
    try {
      await withBusy($("startCampaign"), () => api()("/api/presidential/game/new", { method: "POST", body: JSON.stringify(payload) }), "Кампания создана. Вы вступили в должность президента.");
      $("setupDialog").close();
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