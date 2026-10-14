// Markup of the analytics section, mounted into #analytics on the counter and station pages.
// Ids carry an "an-" prefix so they never collide with the host page.
export const ANALYTICS_HTML = `<div class="an-main">
  <div class="an-head">
    <h2 class="an-title">Traffic analytics</h2>
    <p class="an-lead">Counts by hour, day and weekday, from the counting station or from counts made on this device.</p>
  </div>
      <form class="filters" id="an-filters" aria-label="Analytics filters">
        <label class="f-field">
          <span>Data</span>
          <select id="an-f-source">
            <option value="remote">Counting station</option>
            <option value="device">Counts made on this device</option>
            <option value="csv">CSV file…</option>
          </select>
        </label>
        <label class="f-field">
          <span>Period</span>
          <select id="an-f-range">
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7" selected>Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="all">Everything</option>
            <option value="custom">Choose dates…</option>
          </select>
        </label>
        <label class="f-field" id="an-f-from-wrap" hidden><span>From</span><input type="date" id="an-f-from" /></label>
        <label class="f-field" id="an-f-to-wrap" hidden><span>To</span><input type="date" id="an-f-to" /></label>
        <label class="f-field">
          <span>Line</span>
          <select id="an-f-line"><option value="all">All lines</option></select>
        </label>
        <label class="f-field">
          <span>Direction</span>
          <select id="an-f-dir">
            <option value="both">Both</option>
            <option value="in">In</option>
            <option value="out">Out</option>
          </select>
        </label>
        <fieldset class="f-field f-classes">
          <legend>Vehicles</legend>
          <div class="chips" id="an-f-classes"></div>
        </fieldset>
      </form>

      <div class="source-setup" id="an-remote-setup" hidden>
        <label class="f-field f-wide">
          <span>Station data address</span>
          <input type="url" id="an-f-remote" placeholder="https://raw.githubusercontent.com/user/repo/data/counts/" />
        </label>
        <button class="btn btn-small an-btn" id="an-f-remote-load" type="button">Load</button>
        <p class="note">The counting station publishes its hourly counts here. On the station's own web page this is filled in automatically.</p>
      </div>
      <input type="file" id="an-f-csv" accept=".csv,text/csv" hidden />

      <details class="card sessions" id="an-sessions" hidden>
        <summary>Counting sessions saved on this device</summary>
        <ul class="session-list" id="an-session-list"></ul>
      </details>

      <p class="an-status" id="an-status" hidden></p>
      <p class="empty" id="an-empty" hidden></p>

      <section class="hero" id="an-hero" aria-live="polite">
        <div class="hero-main">
          <span class="hero-number" id="an-h-total">0</span>
          <span class="hero-caption" id="an-h-caption">vehicles</span>
        </div>
        <dl class="figures">
          <div><dt>Busiest hour</dt><dd id="an-h-peak">–</dd></div>
          <div><dt>Per watched hour</dt><dd id="an-h-rate">–</dd></div>
          <div><dt>In, out</dt><dd id="an-h-split">–</dd></div>
          <div><dt>Time watched</dt><dd id="an-h-watched">–</dd></div>
        </dl>
      </section>

      <section class="card" aria-labelledby="an-c-hourly-title">
        <div class="card-head">
          <h2 id="an-c-hourly-title">Vehicles by hour</h2>
          <p class="card-sub" id="an-c-hourly-sub"></p>
        </div>
        <ul class="legend" id="an-legend-classes"></ul>
        <div class="chart" id="an-c-hourly"></div>
        <p class="strip-note">Grey strip under each hour: how much of it the camera was watched.</p>
      </section>

      <section class="card" id="an-card-daily" aria-labelledby="an-c-daily-title">
        <div class="card-head">
          <h2 id="an-c-daily-title">Vehicles per day</h2>
          <p class="card-sub" id="an-c-daily-sub"></p>
        </div>
        <div class="chart" id="an-c-daily"></div>
      </section>

      <section class="card" id="an-card-heat" aria-labelledby="an-c-heat-title">
        <div class="card-head">
          <h2 id="an-c-heat-title">Typical week</h2>
          <p class="card-sub">Average vehicles per hour, by weekday and hour, over the hours the camera was watched.</p>
        </div>
        <div class="chart" id="an-c-heat"></div>
        <div class="ramp-legend" id="an-heat-legend"></div>
      </section>

      <div class="two-up">
        <section class="card" aria-labelledby="an-c-lines-title">
          <div class="card-head"><h2 id="an-c-lines-title">By counting line</h2></div>
          <ul class="legend" id="an-legend-dirs"></ul>
          <div class="chart" id="an-c-lines"></div>
        </section>
        <section class="card" aria-labelledby="an-c-types-title">
          <div class="card-head"><h2 id="an-c-types-title">By vehicle type</h2></div>
          <div class="chart" id="an-c-types"></div>
        </section>
      </div>

      <details class="card table-card">
        <summary>Table of hourly counts</summary>
        <div class="table-actions">
          <button class="btn btn-small an-btn" id="an-dl-csv" type="button">Download CSV</button>
        </div>
        <div class="table-wrap"><table id="an-table"></table></div>
      </details>
    </div>`;
