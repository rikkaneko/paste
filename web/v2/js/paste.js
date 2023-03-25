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

let selected_type = 'file';

function validate_url(path) {
  let url;
  try {
    url = new URL(path);
  } catch (_) {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function show_pop_alert(message, alert_type = 'alert-primary') {
  remove_pop_alert();
  $('body').prepend(jQuery.parseHTML(
      `<div class="alert ${alert_type} alert-dismissible position-absolute top-0 start-50 translate-middle-x outer" 
            style="margin-top: 80px; max-width: 500px; width: 80%" id="pop_alert" role="alert"> \
      <div>${message}</div> \
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button> \
      </div>`,
  ));
}

function remove_pop_alert() {
  const alert = $('#pop_alert');
  if (alert.length)
    alert.remove();
}

$(function () {
  input_div.file = $('#file_upload_layout');
  input_div.text = $('#text_input_layout');
  input_div.url = $('#url_input_layout');
  inputs.file = $('#file_upload');
  inputs.text = $('#text_input');
  inputs.url = $('#url_input');

  let file_stat = $('#file_stats');
  let title = $('#paste_title');
  let char_count = $('#char_count');
  let pass_input = $('#pass_input');
  let show_pass_icon = $('#show_pass_icon');
  let upload_button = $('#upload_button');
  let url_validate_result = $('#url_validate_result');
  let tos_btn = $('#tos_btn');

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

    // Check length
    if (bytes > 10485760) {
      inputs.file.addClass('is-invalid');
      file_stat.addClass('text-danger');
      file_stat.text('The uploaded file is larger than the 10 MB limit.');
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
    if (!validate_url(this.value)) {
      inputs.url.addClass('is-invalid');
      url_validate_result.addClass('text-danger');
      url_validate_result.text('Invalid URL');
    }
  });

  upload_button.on('click', function () {
    inputs[selected_type].trigger('input');
    const form = $('#upload_form')[0];
    const formdata = new FormData(form);
    let content = {};
    formdata.forEach((val, key) => {
      content[key] = val;
    });

    if (inputs[selected_type].hasClass('is-invalid') || !(!!content.u?.size || !!content.u?.length)) {
      show_pop_alert('Please check your upload file or content', 'alert-danger');
      return false;
    }

    if (!tos_btn.prop('checked')) {
      show_pop_alert('Please read the TOS before upload', 'alert-warning');
      return false;
    }

    // TODO Upload to pb service
    show_pop_alert('Paste created!', 'alert-success');
  });
});

function select_input_type(name) {
  selected_type = name;
  Object.keys(input_div).forEach(key => {
    input_div[key].collapse('hide');
    inputs[key].prop('disabled', true);
  });
  input_div[name].collapse('show');
  inputs[name].prop('disabled', false);
  inputs[name].prop('required', true);
}