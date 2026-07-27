/*
 * Radar renderer.
 *
 * Builds the DOM with createElement and textContent throughout — no innerHTML anywhere.
 * Everything on this page (branch names, pull request titles, file paths) is written by
 * other people, and it should be impossible for any of it to become markup.
 */

// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const summaryEl = document.getElementById('summary');
  const noticeEl = document.getElementById('notice');
  const hotspotsEl = document.getElementById('hotspots');
  const hotspotsSection = document.getElementById('hotspots-section');
  const lanesEl = document.getElementById('lanes');
  const lanesSection = document.getElementById('lanes-section');
  const emptyEl = document.getElementById('empty');

  document.getElementById('refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  window.addEventListener('message', (event) => render(event.data));

  // Restore instantly from the retained state so a hidden-then-shown panel does not
  // flash empty while the extension re-sends its payload.
  const previous = vscode.getState();
  if (previous) render(previous);

  vscode.postMessage({ type: 'ready' });

  function render(data) {
    if (!data || !data.summary) return;
    vscode.setState(data);

    renderSummary(data.summary);
    renderNotice(data.summary.message);
    renderHotspots(data.hotspots || [], data.hueColorIds || []);
    renderLanes(data.pullRequests || [], data.hueColorIds || []);

    // Mainline drift is content in its own right: a branch that is behind is worth a
    // screen even with nothing open, which used to be the case that rendered empty.
    const isEmpty =
      (data.pullRequests || []).length === 0 && (data.hotspots || []).length === 0;
    emptyEl.hidden = !isEmpty;
    if (isEmpty) renderEmpty(data.summary.message);
  }

  function renderSummary(summary) {
    clear(summaryEl);

    summaryEl.appendChild(
      stat(summary.pullRequests, plural(summary.pullRequests, 'open pull request', 'open pull requests'))
    );
    summaryEl.appendChild(
      stat(summary.collaborators, plural(summary.collaborators, 'collaborator', 'collaborators'))
    );

    if (summary.behind > 0) {
      const behind = stat(
        summary.behind,
        `${plural(summary.behind, 'commit', 'commits')} on ${summary.mainlineBranch || 'the mainline'} you do not have`
      );
      behind.classList.add('merged');
      summaryEl.appendChild(behind);
    }

    const collisions = stat(
      summary.collisions,
      plural(summary.collisions, 'collision with your work', 'collisions with your work')
    );
    if (summary.collisions > 0) collisions.classList.add('alert');
    summaryEl.appendChild(collisions);

    if (summary.lastSync) {
      const synced = document.createElement('span');
      synced.textContent = `synced ${summary.lastSync}`;
      summaryEl.appendChild(synced);
    }
  }

  function stat(value, label) {
    const wrapper = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    wrapper.appendChild(strong);
    wrapper.appendChild(document.createTextNode(` ${label}`));
    return wrapper;
  }

  function renderNotice(message) {
    if (!message) {
      noticeEl.hidden = true;
      return;
    }
    noticeEl.hidden = false;
    noticeEl.textContent = message;
  }

  function renderHotspots(hotspots, hueColorIds) {
    clear(hotspotsEl);
    hotspotsSection.hidden = hotspots.length === 0;
    if (hotspots.length === 0) return;

    for (const hotspot of hotspots) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hotspot';
      if (hotspot.collisions > 0) row.classList.add('is-colliding');
      row.title = hotspot.path;
      row.addEventListener('click', () => open(hotspot.path));

      row.appendChild(pathLabel(hotspot.path));

      const stack = document.createElement('div');
      stack.className = 'stack';
      // The mainline pip leads: what already landed outranks what might.
      if (hotspot.merged) {
        const pip = document.createElement('span');
        pip.className = 'pip is-merged';
        pip.title = 'Already merged into the mainline';
        stack.appendChild(pip);
      }
      for (const contributor of hotspot.contributors) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pip.style.setProperty('--pip-color', hueVar(contributor.hue, hueColorIds));
        pip.title = `#${contributor.number} · ${contributor.author}`;
        stack.appendChild(pip);
      }
      row.appendChild(stack);

      row.appendChild(hotspotTag(hotspot));
      hotspotsEl.appendChild(row);
    }
  }

  function hotspotTag(hotspot) {
    const tag = document.createElement('span');
    if (hotspot.collisions > 0) {
      tag.className = 'tag collision';
      tag.textContent = `⟂ ${hotspot.collisions}`;
      tag.title = `${hotspot.collisions} ${plural(hotspot.collisions, 'region overlaps', 'regions overlap')} your work`;
    } else if (hotspot.nearMisses > 0) {
      tag.className = 'tag near';
      tag.textContent = `${hotspot.nearMisses} near`;
      tag.title = 'Close to your edits, but not overlapping';
    } else if (hotspot.merged) {
      tag.className = 'tag quiet';
      tag.textContent = 'merged';
      tag.title = 'Work that already landed on the mainline touches this file';
    } else {
      tag.className = 'tag quiet';
      const count = hotspot.contributors.length;
      tag.textContent = `${count} PRs`;
      tag.title = `${count} pull requests touch this file`;
    }
    return tag;
  }

  function renderLanes(pullRequests, hueColorIds) {
    clear(lanesEl);
    lanesSection.hidden = pullRequests.length === 0;
    if (pullRequests.length === 0) return;

    // One scale across every lane, so block widths are comparable between pull requests
    // rather than each lane being normalised to itself.
    let largest = 1;
    for (const pr of pullRequests) {
      for (const file of pr.files) {
        largest = Math.max(largest, file.additions + file.deletions);
      }
    }

    for (const pr of pullRequests) {
      lanesEl.appendChild(lane(pr, largest, hueColorIds));
    }
  }

  function lane(pr, largest, hueColorIds) {
    const root = document.createElement('div');
    root.className = 'lane';
    root.style.setProperty('--lane-color', hueVar(pr.hue, hueColorIds));

    const meta = document.createElement('div');
    meta.className = 'lane-meta';

    const title = document.createElement('div');
    title.className = 'lane-title';
    title.textContent = pr.title;
    title.title = pr.title;
    if (pr.isDraft) {
      const badge = document.createElement('span');
      badge.className = 'draft-badge';
      badge.textContent = 'draft';
      title.appendChild(badge);
    }
    meta.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'lane-sub';
    sub.textContent = `#${pr.number} · ${pr.author} · ${pr.updated}`;
    sub.title = `${pr.branch} · updated ${pr.updated}`;
    meta.appendChild(sub);

    root.appendChild(meta);

    const blocks = document.createElement('div');
    blocks.className = 'lane-blocks';

    const sorted = pr.files.slice().sort((a, b) => {
      const byRisk = (b.collisions > 0) - (a.collisions > 0);
      if (byRisk !== 0) return byRisk;
      return b.additions + b.deletions - (a.additions + a.deletions);
    });

    for (const file of sorted) {
      blocks.appendChild(block(file, largest));
    }

    root.appendChild(blocks);
    return root;
  }

  function block(file, largest) {
    const churn = file.additions + file.deletions;
    // Square root keeps one enormous file from flattening every other block to a sliver.
    const width = 10 + Math.round(Math.sqrt(churn / largest) * 110);

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'block';
    el.style.width = `${width}px`;
    if (file.collisions > 0) el.classList.add('is-colliding');
    else if (file.nearMisses > 0) el.classList.add('is-near');

    const parts = [file.path, `+${file.additions} −${file.deletions}`];
    if (file.collisions > 0) {
      parts.push(`⟂ ${file.collisions} ${plural(file.collisions, 'collision', 'collisions')} with your work`);
    } else if (file.nearMisses > 0) {
      parts.push(`${file.nearMisses} near your edits`);
    }
    el.title = parts.join('\n');
    el.setAttribute('aria-label', parts.join(', '));

    el.addEventListener('click', () => open(file.path));
    return el;
  }

  function renderEmpty(message) {
    clear(emptyEl);

    const headline = document.createElement('div');
    headline.className = 'headline';
    headline.textContent = message ? 'GitRay cannot read this repository' : 'No open pull requests';
    emptyEl.appendChild(headline);

    const detail = document.createElement('div');
    detail.textContent = message
      ? message
      : 'Nothing is in flight right now. Indicators appear as your collaborators open pull requests.';
    emptyEl.appendChild(detail);
  }

  /** Render a path with the directory dimmed, so the filename is what the eye lands on. */
  function pathLabel(path) {
    const el = document.createElement('span');
    el.className = 'path';

    const cut = path.lastIndexOf('/');
    if (cut === -1) {
      el.textContent = path;
      return el;
    }

    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = path.slice(0, cut + 1);
    el.appendChild(dir);
    el.appendChild(document.createTextNode(path.slice(cut + 1)));
    return el;
  }

  function hueVar(hue, hueColorIds) {
    const id = hueColorIds[hue] || hueColorIds[0];
    if (!id) return 'var(--vscode-descriptionForeground)';
    // Theme color ids reach the webview as CSS variables with dots turned into dashes,
    // which means user overrides of the contributed hues apply here too.
    return `var(--vscode-${id.replace(/\./g, '-')}, var(--vscode-descriptionForeground))`;
  }

  function open(path, line) {
    vscode.postMessage({ type: 'openFile', path, line });
  }

  function plural(count, singular, pluralForm) {
    return count === 1 ? singular : pluralForm;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
})();
