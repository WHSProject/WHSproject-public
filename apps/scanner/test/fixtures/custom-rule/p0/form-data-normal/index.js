$('.checkout-form').submit(function () {
  const form = $('.checkout-form');
  $.ajax({
    url: '/checkout/submit',
    type: 'POST',
    data: form.serialize(),
  });
});
