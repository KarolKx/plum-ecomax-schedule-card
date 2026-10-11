class PlumEcomaxScheduleCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('plum-ecomax-schedule-card-editor');
  }

  static getStubConfig() {
    return {
      device_id: '',
      schedules: ['heating', 'water_heater', 'thermostat_1'],
      height: 480,
    };
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid configuration');
    }
    if (!config.device_id) {
      throw new Error('device_id is required');
    }
    if (!Array.isArray(config.schedules) || !config.schedules.length) {
      throw new Error('schedules must not be empty');
    }

    this.config = {
      schedules: ['heating', 'water_heater', 'thermostat_1'],
      height: 700,
      ...config,
    };
    this.scheduleType = this.config.schedules[0];
    this.days = [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ];
    this.dayLabels = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
    this.slots = Array.from(
      { length: 48 },
      (_, i) =>
        `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
    );

    this._data = null;
    this._original = null;
    this._refreshing = false;
    this._saving = false;
    this._dragging = false;
    this._dragValue = null;
    this._loaded = false;
    this._editMode = false;
    this._pointerUp = () => this._stopDrag();

    this.render();
  }

  set hass(hass) {
    this._hass = hass;

    // Home Assistant może ustawić hass dopiero po pierwszym renderze.
    // Wtedy pierwsze dotknięcie komórki nie może uruchamiać odczytu
    // harmonogramu tylko dlatego, że _loaded nadal jest false.
    if (
      this.config &&
      this._data &&
      !this._loaded
    ) {
      this._loaded = true;
      queueMicrotask(() => this.refresh());
    }
  }

  getCardSize() {
    return 12;
  }

  _clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  _emptySchedule() {
    const data = {};

    for (const day of this.days) {
      data[day] = {};

      for (const slot of this.slots) {
        data[day][slot] = 'night';
      }
    }

    return data;
  }

  _normalizeSchedule(raw) {
    const source = raw?.schedule ?? raw ?? {};
    const data = this._emptySchedule();

    for (const day of this.days) {
      const src = source?.[day] ?? {};

      for (const slot of this.slots) {
        data[day][slot] =
          src[slot] === 'day' || src[slot] === 'on'
            ? 'day'
            : 'night';
      }
    }

    return data;
  }

  _isDirty() {
    return JSON.stringify(this._data) !== JSON.stringify(this._original);
  }

  async refresh() {
    if (this._refreshing || this._saving || !this._hass) return;

    this._refreshing = true;
    this.status = 'Odczytuję…';
    this.render();

    try {
      const result = await this._hass.callWS({
        type: 'call_service',
        domain: 'plum_ecomax',
        service: 'get_schedule',
        service_data: {
          device_id: this.config.device_id,
          type: this.scheduleType,
          weekdays: this.days,
        },
        return_response: true,
      });

      this._data = this._normalizeSchedule(
        result?.response ?? result?.result ?? result,
      );

      this._original = this._clone(this._data);
      this.status = 'Odczytano';
    } catch (e) {
      this.status = `Błąd odczytu: ${e?.message || e}`;
    } finally {
      this._refreshing = false;
      this.render();
    }
  }

  async save() {
    if (
      !this._data ||
      this._saving ||
      this._refreshing ||
      !this._hass
    ) {
      return;
    }

    const changed = this._isDirty();

    if (!changed) {
      this.status = 'Brak zmian';
      this.render();
      return;
    }

    const scheduleLabel =
      this.scheduleType === 'heating'
        ? 'kotła'
        : this.scheduleType === 'water_heater'
          ? 'CWU'
          : this.scheduleType === 'thermostat_1'
            ? 'termostatu 1'
            : this.scheduleType;

    const confirmed = window.confirm(
      `Zapisać harmonogram ${scheduleLabel}?\n\n` +
        'Cały tygodniowy harmonogram (7 dni × 48 pól) zostanie zapisany jednym wywołaniem set_schedule_grid.',
    );

    if (!confirmed) return;

    this._saving = true;
    this.status = 'Zapisuję…';
    this.render();

    try {
      /*
       * Jeden zapis całego tygodnia.
       *
       * Nie wykonujemy osobnych wywołań dla poszczególnych
       * przedziałów czasowych.
       */
      await this._hass.callService(
        'plum_ecomax',
        'set_schedule_grid',
        {
          device_id: this.config.device_id,
          type: this.scheduleType,
          schedule: this._clone(this._data),
        },
      );

      /*
       * Po zapisie ponownie odczytujemy harmonogram,
       * aby UI pokazywało dokładnie to, co zwrócił sterownik.
       */
      const result = await this._hass.callWS({
        type: 'call_service',
        domain: 'plum_ecomax',
        service: 'get_schedule',
        service_data: {
          device_id: this.config.device_id,
          type: this.scheduleType,
          weekdays: this.days,
        },
        return_response: true,
      });

      this._data = this._normalizeSchedule(
        result?.response ?? result?.result ?? result,
      );

      this._original = this._clone(this._data);
      this.status = 'Zapisano i potwierdzono odczytem';
    } catch (e) {
      this.status = `Błąd zapisu: ${e?.message || e}`;
    } finally {
      this._saving = false;
      this.render();
    }
  }

  _setCell(day, slot, value) {
    if (!this._data) return;

    this._data[day][slot] = value;
  }

  _toggleCell(day, slot) {
    if (!this._data) return;

    this._data[day][slot] =
      this._data[day][slot] === 'day'
        ? 'night'
        : 'day';
  }

  _copyDay(from, to) {
    if (!this._data || from === to) return;

    this._data[to] = {
      ...this._data[from],
    };
  }

  _clearDay(day) {
    if (!this._data) return;

    for (const slot of this.slots) {
      this._data[day][slot] = 'night';
    }
  }

  _stopDrag() {
    this._dragging = false;
    this._dragValue = null;
  }

  _bindGrid() {
    const grid = this.querySelector('.grid');
    if (!grid) return;

    let dragging = false;
    let dragValue = null;
    let pointerId = null;
    let startDay = null;
    let startSlot = null;

    const applyCell = (cell, value) => {
      if (!cell || !this._data) return;

      const { day, slot } = cell.dataset;

      this._setCell(
        day,
        slot,
        value ? 'day' : 'night',
      );

      cell.classList.toggle('day', value);
    };

    const selectRange = (endCell) => {
      if (
        !this._data ||
        dragValue === null ||
        !startDay ||
        !startSlot ||
        !endCell
      ) {
        return;
      }

      const endDay = endCell.dataset.day;
      const endSlot = endCell.dataset.slot;

      const dayStart = this.days.indexOf(startDay);
      const dayEnd = this.days.indexOf(endDay);
      const slotStart = this.slots.indexOf(startSlot);
      const slotEnd = this.slots.indexOf(endSlot);

      if (
        dayStart < 0 ||
        dayEnd < 0 ||
        slotStart < 0 ||
        slotEnd < 0
      ) {
        return;
      }

      const minDay = Math.min(dayStart, dayEnd);
      const maxDay = Math.max(dayStart, dayEnd);
      const minSlot = Math.min(slotStart, slotEnd);
      const maxSlot = Math.max(slotStart, slotEnd);

      for (let d = minDay; d <= maxDay; d += 1) {
        for (let s = minSlot; s <= maxSlot; s += 1) {
          this._setCell(
            this.days[d],
            this.slots[s],
            dragValue ? 'day' : 'night',
          );
        }
      }

      this.querySelectorAll('.cell').forEach((cell) => {
        const d = this.days.indexOf(cell.dataset.day);
        const s = this.slots.indexOf(cell.dataset.slot);

        if (
          d >= minDay &&
          d <= maxDay &&
          s >= minSlot &&
          s <= maxSlot
        ) {
          cell.classList.toggle('day', dragValue);
        }
      });
    };

    const cellFromPoint = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest?.('.cell') || null;
    };

    const finish = (endCell) => {
      if (dragging && endCell) {
        selectRange(endCell);
      }

      dragging = false;
      dragValue = null;
      pointerId = null;
      startDay = null;
      startSlot = null;
    };

    const cells = grid.querySelectorAll('.cell');

    cells.forEach((cell) => {
      cell.addEventListener(
        'pointerdown',
        (event) => {
          if (
            !this._editMode ||
            this._saving ||
            this._refreshing
          ) {
            return;
          }

          const { day, slot } = cell.dataset;

          dragging = true;
          pointerId = event.pointerId;
          startDay = day;
          startSlot = slot;

          dragValue =
            this._data[day][slot] !== 'day';

          // Pojedyncze dotknięcie działa natychmiast.
          applyCell(cell, dragValue);

          try {
            cell.setPointerCapture(
              event.pointerId,
            );
          } catch (_) {}

          event.preventDefault();
          event.stopPropagation();
        },
        { passive: false },
      );

      cell.addEventListener(
        'touchstart',
        (event) => {
          if (
            !this._editMode ||
            this._saving ||
            this._refreshing ||
            dragging
          ) {
            return;
          }

          const { day, slot } = cell.dataset;

          dragging = true;
          pointerId = null;
          startDay = day;
          startSlot = slot;

          dragValue =
            this._data[day][slot] !== 'day';

          applyCell(cell, dragValue);

          event.preventDefault();
          event.stopPropagation();
        },
        { passive: false },
      );
    });

    grid.addEventListener(
      'pointermove',
      (event) => {
        if (
          !this._editMode ||
          !dragging ||
          pointerId !== event.pointerId ||
          this._saving ||
          this._refreshing
        ) {
          return;
        }

        const cell = cellFromPoint(
          event.clientX,
          event.clientY,
        );

        if (cell) {
          applyCell(cell, dragValue);
        }

        event.preventDefault();
      },
      { passive: false },
    );

    grid.addEventListener(
      'pointerup',
      (event) => {
        if (
          pointerId !== null &&
          event.pointerId !== pointerId
        ) {
          return;
        }

        const cell = cellFromPoint(
          event.clientX,
          event.clientY,
        );

        finish(cell);
      },
      { passive: true },
    );

    grid.addEventListener(
      'pointercancel',
      () => finish(null),
      { passive: true },
    );

    grid.addEventListener(
      'touchmove',
      (event) => {
        if (
          !this._editMode ||
          !dragging ||
          this._saving ||
          this._refreshing
        ) {
          return;
        }

        const touch = event.touches?.[0];
        if (!touch) return;

        const cell = cellFromPoint(
          touch.clientX,
          touch.clientY,
        );

        if (cell) {
          applyCell(cell, dragValue);
        }

        event.preventDefault();
      },
      { passive: false },
    );

    grid.addEventListener(
      'touchend',
      (event) => {
        if (!dragging) return;

        const touch =
          event.changedTouches?.[0];

        const cell = touch
          ? cellFromPoint(
              touch.clientX,
              touch.clientY,
            )
          : null;

        finish(cell);
      },
      { passive: true },
    );

    grid.addEventListener(
      'touchcancel',
      () => finish(null),
      { passive: true },
    );

    const button = this.querySelector('.edit-range');

    if (button) {
      button.onclick = () => {
        this._editMode = !this._editMode;

        // Nie wykonujemy render() przy włączaniu edycji.
        // Dzięki temu pozycja przewinięcia harmonogramu
        // pozostaje dokładnie tam, gdzie była.
        grid.classList.toggle(
          'edit-mode',
          this._editMode,
        );

        button.textContent = this._editMode
          ? 'Zakończ zaznaczanie'
          : 'Zaznacz zakres';

        button.classList.toggle(
          'active',
          this._editMode,
        );

        // Wyczyść dzień jest aktywne tylko w trybie edycji.
        const clearDay =
          this.querySelector('.clear-day');

        if (clearDay) {
          clearDay.disabled =
            this._refreshing ||
            this._saving ||
            !this._editMode;
        }

        // Zapisz jest dostępne dopiero po wyjściu z edycji.
        const saveButton =
          this.querySelector('.save');

        if (saveButton) {
          saveButton.disabled =
            this._refreshing ||
            this._saving ||
            this._editMode ||
            !this._isDirty();
        }
      };
    }
  }

  render() {
    // Zachowaj pozycję przewijania tabeli podczas odświeżania DOM.
    // Bez tego każde kliknięcie komórki tworzy nowy .grid i wraca na 00:00.
    const oldGrid = this.querySelector('.grid');
    const scrollTop = oldGrid
      ? oldGrid.scrollTop
      : (this._gridScrollTop || 0);
    const scrollLeft = oldGrid
      ? oldGrid.scrollLeft
      : (this._gridScrollLeft || 0);

    if (!this.config || !this._data) {
      if (this.config) {
        this._data = this._emptySchedule();
      }
    }

    if (!this.config || !this._data) return;

    const busy =
      this._refreshing || this._saving;

    const dirty = this._isDirty();

    const typeButtons = this.config.schedules
      .map((type) => {
        const label =
          type === 'heating'
            ? '🔥 Kocioł'
            : type === 'water_heater'
              ? '💧 CWU'
              : type === 'thermostat_1'
                ? '🌡️ Termostat 1'
                : type;

        return `
          <button
            class="tab ${type === this.scheduleType ? 'active' : ''}"
            data-type="${type}"
            ${busy ? 'disabled' : ''}
          >
            ${label}
          </button>
        `;
      })
      .join('');

    const head =
      `<div class="corner"></div>` +
      this.dayLabels
        .map(
          (label) =>
            `<div class="head">${label}</div>`,
        )
        .join('');

    const rows = this.slots
      .map(
        (slot) =>
          `<div class="time">${slot}</div>` +
          this.days
            .map(
              (day) =>
                `<div
                  class="cell ${
                    this._data[day][slot] === 'day'
                      ? 'day'
                      : ''
                  }"
                  data-day="${day}"
                  data-slot="${slot}"
                  title="${day} ${slot}"
                ></div>`,
            )
            .join(''),
      )
      .join('');

    const copy =
      `<select class="copy-source" ${
        busy ? 'disabled' : ''
      }>
        <option value="">Kopiuj dzień…</option>
        ${this.days
          .map(
            (day, i) =>
              `<option value="${day}">
                ${this.dayLabels[i]}
              </option>`,
          )
          .join('')}
      </select>` +
      `<select class="copy-target" ${
        busy ? 'disabled' : ''
      }>
        <option value="">do…</option>
        ${this.days
          .map(
            (day, i) =>
              `<option value="${day}">
                ${this.dayLabels[i]}
              </option>`,
          )
          .join('')}
      </select>` +
      `<button class="copy-day" ${
        busy ? 'disabled' : ''
      }>Kopiuj</button>`;

    this.innerHTML = `
      <ha-card>
        <div class="wrap">

          <div class="tabs">
            ${typeButtons}
          </div>

          <div class="actions">
            <button
              class="refresh"
              ${busy ? 'disabled' : ''}
            >
              Odśwież
            </button>

            <button
              class="save"
              ${busy || !dirty || this._editMode ? 'disabled' : ''}
            >
              Zapisz${dirty ? ' *' : ''}
            </button>

            <button
              class="edit-range"
              ${busy ? 'disabled' : ''}
            >
              ${this._editMode ? 'Zakończ zaznaczanie' : 'Zaznacz zakres'}
            </button>

            <span class="status">
              ${this.status || ''}
            </span>
          </div>

          <div
            class="grid"
            style="--card-height:${
              Number(this.config.height) || 480
            }px"
          >
            ${head}
            ${rows}
          </div>

          <div class="tools">
            ${copy}

            <select
              class="clear-day"
              ${busy || !this._editMode ? 'disabled' : ''}
            >
              <option value="">
                Wyczyść dzień…
              </option>

              <option value="all">
                Wszystkie dni
              </option>

              ${this.days
                .map(
                  (day, i) =>
                    `<option value="${day}">
                      ${this.dayLabels[i]}
                    </option>`,
                )
                .join('')}
            </select>
          </div>

          <div class="hint">
            Włącz „Zaznacz zakres”, a następnie dotykaj pojedynczych pól,
            aby przełączać <b>day</b> / <b>night</b>.
            „Wyczyść dzień” jest dostępne tylko w trybie edycji.
            <b>day</b> = aktywny,
            <b>night</b> = nieaktywny.
            Zapis wysyła jeden pełny harmonogram
            przez set_schedule_grid.
          </div>

        </div>
      </ha-card>
    `;

    const style =
      document.createElement('style');

    style.textContent = `
      :host {
        display: block;
      }

      .wrap {
        padding: 12px;
      }

      .title {
        font-size: 1.25rem;
        font-weight: 600;
        margin-bottom: 8px;
      }

      .tabs,
      .actions,
      .tools {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin: 8px 0;
      }

      button,
      select {
        font: inherit;
        border: 1px solid var(--divider-color);
        background:
          var(
            --ha-card-background,
            var(--card-background-color)
          );
        color: var(--primary-text-color);
        border-radius: 8px;
        padding: 7px 10px;
      }

      button:disabled,
      select:disabled {
        opacity: 0.5;
      }

      .tabs .active {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
      }

      .save:not(:disabled) {
        font-weight: 600;
      }

      .status {
        font-size: 0.9em;
        color: var(--secondary-text-color);
      }

      /*
       * 22 px na ekranach desktopowych.
       * Na telefonie poniżej zwiększamy do 28 px,
       * aby pola były wygodniejsze do zaznaczania palcem.
       */
      .grid {
        display: grid;
        grid-template-columns:
          48px
          repeat(7, minmax(28px, 1fr));

        grid-auto-rows: 22px;

        height: var(--card-height);
        overflow: auto;

        border: 1px solid
          var(--divider-color);

        border-radius: 8px;

        touch-action: pan-x pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
      }

      .corner,
      .head,
      .time,
      .cell {
        border-right:
          1px solid
          var(--divider-color);

        border-bottom:
          1px solid
          var(--divider-color);

        box-sizing: border-box;
      }

      .corner,
      .head,
      .time {
        display: flex;
        align-items: center;
        justify-content: center;

        font-size: 0.72em;

        color:
          var(--secondary-text-color);

        position: sticky;

        background:
          var(
            --ha-card-background,
            var(--card-background-color)
          );

        z-index: 2;
      }

      .head {
        top: 0;
        font-weight: 600;
      }

      .corner {
        left: 0;
        z-index: 4;
      }

      .time {
        left: 0;
        z-index: 3;
      }

      .cell {
        cursor: pointer;

        background:
          var(--secondary-background-color);
      }

      .cell.day {
        background:
          var(--primary-color);
      }

      .edit-range.active {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        font-weight: 600;
      }

      .grid.edit-mode {
        touch-action: none;
        overscroll-behavior: contain;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }

      .grid.edit-mode .cell {
        touch-action: none;
        -webkit-tap-highlight-color: transparent;
      }

      .hint {
        font-size: 0.78em;
        color: var(--secondary-text-color);
        margin-top: 8px;
      }

      /*
       * Telefon:
       * każdy 30-minutowy przedział ma 28 px wysokości,
       * dzięki czemu łatwiej zaznaczać zakres przeciągnięciem.
       */
      @media (max-width: 600px) {
        .grid {
          grid-auto-rows: 28px;
          height: 520px !important;
        }

        .time {
          font-size: 0.68em;
        }
      }
    `;

    this.appendChild(style);

    // Przywróć pozycję przewijania po przebudowaniu tabeli.
    const newGrid = this.querySelector('.grid');
    if (newGrid) {
      newGrid.scrollTop = scrollTop;
      newGrid.scrollLeft = scrollLeft;

      newGrid.addEventListener(
        'scroll',
        () => {
          this._gridScrollTop = newGrid.scrollTop;
          this._gridScrollLeft = newGrid.scrollLeft;
        },
        { passive: true },
      );
    }

    this.querySelectorAll('.tab')
      .forEach((button) => {
        button.onclick = () => {
          this.scheduleType =
            button.dataset.type;

          this._data = null;
          this._original = null;

          this.refresh();
        };
      });

    this.querySelector(
      '.refresh',
    ).onclick = () =>
      this.refresh();

    this.querySelector(
      '.save',
    ).onclick = () =>
      this.save();

    this.querySelector(
      '.copy-day',
    ).onclick = () => {
      const from =
        this.querySelector(
          '.copy-source',
        ).value;

      const to =
        this.querySelector(
          '.copy-target',
        ).value;

      if (
        from &&
        to &&
        from !== to
      ) {
        this._copyDay(from, to);
        this.render();
      }
    };

    this.querySelector(
      '.clear-day',
    ).onchange = (event) => {
      const day =
        event.target.value;

      if (day === 'all') {
        for (const currentDay of this.days) {
          this._clearDay(currentDay);
        }
        this.render();
      } else if (day) {
        this._clearDay(day);
        this.render();
      }
    };

    this._bindGrid();


  }
}

class PlumEcomaxScheduleCardEditor
  extends HTMLElement {
  setConfig(config) {
    this.config = {
      ...config,
    };

    this.innerHTML = '';
  }

  set hass(hass) {
    this._hass = hass;
  }
}

if (
  !customElements.get(
    'plum-ecomax-schedule-card-editor',
  )
) {
  customElements.define(
    'plum-ecomax-schedule-card-editor',
    PlumEcomaxScheduleCardEditor,
  );
}

if (
  !customElements.get(
    'plum-ecomax-schedule-card',
  )
) {
  customElements.define(
    'plum-ecomax-schedule-card',
    PlumEcomaxScheduleCard,
  );
}

window.customCards =
  window.customCards || [];

window.customCards.push({
  type: 'plum-ecomax-schedule-card',
  name: 'Plum ecoMAX Schedule Card',
  description:
    'Weekly 30-minute ecoMAX schedule editor',
});