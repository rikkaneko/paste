/*
 * This file is part of paste.
 * Copyright (c) 2023 Joe Ma <rikkaneko23@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/// <reference path="../../node_modules/@types/bootstrap/index.d.ts" />

const ENDPOINT = '';

let input_div = {
  file: null,
  text: null,
  url: null,
};

let inputs = {
  file: null,
  text: null,
  url: null,
};

let paste_modal = {
  modal: null,
  uuid: null,
  qrcode: null,
  title: null,
  expired: null,
  id_copy_btn: null,
  id_copy_btn_icon: null,
  forget_btn: null,
};

let cached_paste_info = null;
let show_saved_btn = null;
let show_qrcode = true;

function validate_url(path) {
  let url;
  try {
    url = new URL(path);
  } catch (_) {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function show_pop_alert(message, alert_type = 'alert-primary', add_classes = null) {
  remove_pop_alert();
  $('#alert-container').prepend(
    jQuery.parseHTML(
      `<div class="alert ${alert_type} alert-dismissible position-absolute fade show top-0 start-50 translate-middle-x" 
            style="margin-top: 30px; max-width: 500px; width: 80%" id="pop_alert" role="alert"> \
      <div>${message}</div> \
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button> \
      </div>`
    )
  );
  if (add_classes) {
    $('.alert').addClass(add_classes);
  }
  window.scrollTo(0, 0);
}

function remove_pop_alert() {
  const alert = $('#pop_alert');
  if (alert.length) alert.remove();
}

function build_paste_modal(paste_info, show_qrcode = true, saved = true, build_only = false) {
  let tooltip = bootstrap.Tooltip.getInstance(paste_modal.id_copy_btn);

  paste_modal.uuid.text(paste_info.link);
  paste_modal.qrcode.prop('src', paste_info.link_qr);
  paste_modal.qrcode.prop('alt', paste_info.link);
  paste_modal.id_copy_btn_icon.addClass('bi-clipboard');
  paste_modal.id_copy_btn_icon.removeClass('bi-check2');
  paste_modal.id_copy_btn.addClass('btn-primary');
  paste_modal.id_copy_btn.removeClass('btn-success');
  tooltip.setContent({ '.tooltip-inner': 'Click to copy' });

  if (saved) {
    cached_paste_info = paste_info;
    localStorage.setItem('last_paste', JSON.stringify(paste_info));
    console.log('Paste saved');
    show_saved_btn.prop('disabled', false);
  }

  // Hide/Show QRCode
  if (!show_qrcode) paste_modal.qrcode.addClass('d-none');
  else paste_modal.qrcode.removeClass('d-none');

  // Hide/Show Forget button
  if (cached_paste_info) paste_modal.forget_btn.removeClass('d-none');
  else paste_modal.forget_btn.addClass('d-none');

  Object.entries(paste_info).forEach(([key, val]) => {
    if (key.includes('link')) return;
    $(`#paste_info_${key}`).text(val ?? '-');
  });

  let modal = new bootstrap.Modal(paste_modal.modal);
  if (!build_only) modal.show();
}

/**
 * @param file {File}
 * @returns {str}
 */
async function get_file_hash(file) {
  const word_arr = CryptoJS.lib.WordArray.create(await file.arrayBuffer());
  const file_hash = CryptoJS.SHA256(word_arr).toString(CryptoJS.enc.Hex);
  return file_hash;
}

$(function () {
  input_div.file = $('#file_upload_layout');
  input_div.text = $('#text_input_layout');
  input_div.url = $('#url_input_layout');
  inputs.file = $('#file_upload');
  inputs.text = $('#text_input');
  inputs.url = $('#url_input');
  paste_modal.modal = $('#paste_modal');
  paste_modal.uuid = $('#paste_uuid');
  paste_modal.qrcode = $('#paste_qrcode');
  paste_modal.id_copy_btn = $('#id_copy_button');
  paste_modal.id_copy_btn_icon = $('#id_copy_button_icon');
  paste_modal.forget_btn = $('#forget_btn');

  let file_stat = $('#file_stats');
  let title = $('#paste_title');
  let char_count = $('#char_count');
  let pass_input = $('#pass_input');
  let show_pass_icon = $('#show_pass_icon');
  let upload_button = $('#upload_button');
  let url_validate_result = $('#url_validate_result');
  let tos_btn = $('#tos_btn');
  show_saved_btn = $('#show_saved_button');
  let go_btn = $('#go_button');
  let go_id = $('#go_paste_id');
  let view_btn = $('#view_info_button');
  let show_qrcode_checkbox = $('#show_qrcode_checkbox');

  // Enable bootstrap tooltips
  const tooltip_trigger_list = [].slice.call($('[data-bs-toggle="tooltip"]'));
  const tooltip_list = tooltip_trigger_list.map(function (e) {
    return new bootstrap.Tooltip(e);
  });

  // Restore saved paste info
  cached_paste_info = JSON.parse(localStorage.getItem('last_paste'));
  if (cached_paste_info) {
    show_saved_btn.prop('disabled', false);
    console.log('Restored cache paste');
  }

  inputs.file.on('change', function () {
    inputs.file.removeClass('is-invalid');
    file_stat.removeClass('text-danger');
    if (this.files[0] === undefined) {
      file_stat.textContent = '0 bytes';
      return;
    }
    let bytes = this.files[0]?.size ?? 0;
    let size = bytes + ' bytes';
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    for (let i = 0, approx = bytes / 1024; approx > 1; approx /= 1024, i++) {
      size = approx.toFixed(3) + ' ' + units[i];
    }
    title.val(this.files[0]?.name || '');
    file_stat.text(`${this.files[0]?.type || 'application/octet-stream'}, ${size}`);

    // Check length <= 250MB
    if (bytes > 262144000) {
      inputs.file.addClass('is-invalid');
      file_stat.addClass('text-danger');
      file_stat.text('The uploaded file is larger than the 250MB limit.');
    }
  });

  inputs.text.on('input', function () {
    inputs.text.removeClass('is-invalid');
    char_count.removeClass('text-danger');
    char_count.text(`${this.value.length} characters`);
    if (this.value.length <= 0) {
      inputs.text.addClass('is-invalid');
      char_count.addClass('text-danger');
      char_count.text('Input text cannot be empty.');
    }
  });

  $('#show_pass_button').on('click', function () {
    if (pass_input.attr('type') === 'password') {
      pass_input.attr('type', 'text');
      show_pass_icon.removeClass('bi-eye bi-eye-slash');
      show_pass_icon.addClass('bi-eye');
    } else if (pass_input.attr('type') === 'text') {
      pass_input.attr('type', 'password');
      show_pass_icon.removeClass('bi-eye bi-eye-slash');
      show_pass_icon.addClass('bi-eye-slash');
    }
  });

  inputs.url.on('input', function () {
    inputs.url.removeClass('is-invalid');
    url_validate_result.removeClass('text-danger');
    url_validate_result.text('');
    if (!validate_url(this.value)) {
      inputs.url.addClass('is-invalid');
      url_validate_result.addClass('text-danger');
      url_validate_result.text('Invalid URL');
    }
  });

  upload_button.on('click', async function () {
    const form = $('#upload_form')[0];
    let formdata = new FormData(form);
    const type = formdata.get('paste-type');
    /** @type {File} */
    const content = formdata.get('u');

    inputs[type].trigger('input');
    if (inputs[type].hasClass('is-invalid') || !(!!content?.size || !!content?.length)) {
      show_pop_alert('Please check your upload file or content', 'alert-danger');
      return false;
    }

    if (!tos_btn.prop('checked')) {
      show_pop_alert('Please read the team and conditions before upload', 'alert-warning', 'tos-alert');
      tos_btn.addClass('is-invalid');
      return false;
    }

    upload_button.prop('disabled', true);
    upload_button.text('Waiting...');

    // Hanlde large paste (> 10MB)
    if (content.size > 10485760) {
      const file_hash = await get_file_hash(content);
      const params = {
        title: content.name,
        'file-size': content.size,
        'file-sha256-hash': file_hash,
        'mime-type': content.type,
        'read-limit': formdata.get('read-limit') || undefined,
        pass: formdata.get('pass') || undefined,
      };

      // Remove empty entries
      const filtered = new FormData();
      Object.entries(params).forEach(([key, val]) => {
        if (val) filtered.set(key, val);
      });

      try {
        // Retrieve presigned URL for upload large paste
        const res = await fetch(`${ENDPOINT}/v2/large_upload/create`, {
          method: 'POST',
          body: filtered,
        });

        if (!res.ok) {
          throw new Error(`Unable to create paste: ${(await res.text()) || `${res.status} ${res.statusText}`}`);
        }
        // Upload the paste to the endpoint
        upload_button.text('Uploading...');
        const create_result = await res.json();
        const res1 = await fetch(create_result.signed_url, {
          method: 'PUT',
          headers: {
            'X-Amz-Content-Sha256': file_hash,
          },
          body: content,
        });

        if (!res1.ok) {
          throw new Error(`Unable to upload paste: ${(await res1.text()) || `${res1.status} ${res1.statusText}`}`);
        }
        // Finialize the paste
        const res2 = await fetch(`${ENDPOINT}/v2/large_upload/complete/${create_result.uuid}`, {
          method: 'POST',
        });
        if (res2.ok) {
          const complete_result = await res2.json();
          build_paste_modal(complete_result.paste_info, show_qrcode);
          show_pop_alert(`Paste #${complete_result.paste_info.uuid} created!`, 'alert-success');
          pass_input.val('');
        } else {
          throw new Error(`Unable to finialize paste: ${(await res2.text()) || `${res2.status} ${res2.statusText}`}`);
        }
      } catch (err) {
        console.log('error', err);
        show_pop_alert(err.message, 'alert-danger');
      }
    } else {
      // Handle normal paste (<= 25MB)
      switch (type) {
        case 'file':
        case 'text':
          formdata.set('paste-type', 'paste');
          break;
        case 'url':
          formdata.set('paste-type', 'link');
      }

      // Remove empty entries
      let filtered = new FormData();
      formdata.forEach((val, key) => {
        if (val) filtered.set(key, val);
      });
      // Request JSON response
      filtered.set('json', '1');
      try {
        const res = await fetch(`${ENDPOINT}/`, {
          method: 'POST',
          body: filtered,
        });

        if (res.ok) {
          const paste_info = await res.json();
          build_paste_modal(paste_info, show_qrcode);
          show_pop_alert(`Paste #${paste_info.uuid} created!`, 'alert-success');
          pass_input.val('');
        } else {
          throw new Error('Unable to upload paste');
        }
      } catch (err) {
        console.log('error', err);
        show_pop_alert(err.message, 'alert-danger');
      }
    }

    upload_button.prop('disabled', false);
    upload_button.text('Upload');
  });

  tos_btn.on('click', function () {
    tos_btn.removeClass('is-invalid');
    $('.tos-alert').remove();
  });

  show_saved_btn.on('click', function () {
    if (!cached_paste_info) {
      show_pop_alert('No saved paste found.', 'alert-warning');
      return;
    }
    build_paste_modal(cached_paste_info, show_qrcode, false);
  });

  go_btn.on('click', function () {
    const uuid = go_id.val();
    if (uuid.length !== 4) {
      show_pop_alert('Invalid Paste ID.', 'alert-warning');
      return;
    }
    window.open(`/${uuid}`);
  });

  view_btn.on('click', async function () {
    const uuid = go_id.val();
    if (uuid.length !== 4) {
      show_pop_alert('Invalid Paste ID.', 'alert-warning');
      return;
    }

    try {
      const res = await fetch(`${ENDPOINT}/${uuid}/settings?${new URLSearchParams({ json: '1' })}`);
      if (res.ok) {
        const paste_info = await res.json();
        build_paste_modal(paste_info, show_qrcode, false);
      } else {
        show_pop_alert('Invalid Paste ID.', 'alert-warning');
      }
    } catch (err) {
      console.log('error', err);
      show_pop_alert(err.message, 'alert-danger');
    }
  });

  paste_modal.id_copy_btn.on('click', async function () {
    const uuid = paste_modal.uuid.text();
    let tooltip = bootstrap.Tooltip.getInstance(paste_modal.id_copy_btn);

    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(uuid);
        paste_modal.id_copy_btn_icon.removeClass('bi-clipboard');
        paste_modal.id_copy_btn_icon.addClass('bi-check2');
        paste_modal.id_copy_btn.removeClass('btn-primary');
        paste_modal.id_copy_btn.addClass('btn-success');
        tooltip.setContent({ '.tooltip-inner': 'Copied' });
      } catch (err) {
        tooltip.setContent({ '.tooltip-inner': 'Copied failed' });
      }
    } else {
      tooltip.setContent({ '.tooltip-inner': 'Copied failed' });
    }
  });

  paste_modal.forget_btn.on('click', function () {
    let tooltip = bootstrap.Tooltip.getInstance(paste_modal.forget_btn);

    if (cached_paste_info) {
      cached_paste_info = null;
      localStorage.removeItem('last_paste');
      console.log('Removed cached paste');
      tooltip.setContent({ '.tooltip-inner': 'Forgotten!' });
      show_saved_btn.prop('disabled', true);
    }
  });

  show_qrcode_checkbox.on('click', function () {
    show_qrcode = show_qrcode_checkbox.prop('checked');
  });
});

function select_input_type(name) {
  Object.keys(input_div).forEach((key) => {
    input_div[key].collapse('hide');
    inputs[key].prop('disabled', true);
  });
  input_div[name].collapse('show');
  inputs[name].prop('disabled', false);
  inputs[name].prop('required', true);
}
