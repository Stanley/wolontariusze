'use strict'
var createStore = require('fluxible/addons').createStore

var ApplicationStore = createStore({
  storeName: 'ApplicationStore',
  handlers: {
    'CHANGE_ROUTE_SUCCESS' : 'handleNavigate',
    'UPDATE_PAGE_TITLE'    : 'updatePageTitle',
    'SAVE_FLASH_SUCCESS'   : 'saveSuccess',
    'SAVE_FLASH_FAILURE'   : 'saveFailure',
    'INSTAGRAM_CONFIG'     : 'setInstagram',
    'ADMIN_CONSENT'        : 'setConsent',
    'LOAD_AUTOCOMPLETE'    : 'autocomplete'
  },

  initialize: function () {
    this.title = ''
  },

  saveFailure: function(message) {
    this.flashFailure = message
    this.emitChange()
  },

  saveSuccess: function(message) {
    this.flashSuccess = message
    this.emitChange()
  },

  getFailure: function() {
    return this.flashFailure
  },

  getSuccess: function() {
    return this.flashSuccess
  },

  updatePageTitle: function (title) {
    this.title = title.title
    this.emitChange()
  },

  getPageTitle: function () {
    return this.title
  },

  setInstagram: function(instagram_client_id) {
    this.instagram_client_id = instagram_client_id
    this.emitChange()
  },

  setConsent: function() {
    this.consent = true
    this.emitChange()
  },

  autocomplete: function(data) {
    this.autocomplete = data
  },

  getState: function () {
    return {
      currentPageName: this.currentPageName,
      currentPage: this.currentPage,
      pages: this.pages,
      route: this.currentRoute,
      title: this.title,
      flashSuccess: this.flashSuccess,
      flashFailure: this.flashFailure,
      instagram_client_id: this.instagram_client_id,
      autocomplete: this.autocomplete
    }
  },

  dehydrate: function () {
    return this.getState()
  },

  rehydrate: function (state) {
    this.currentPageName = state.currentPageName
    this.currentPage = state.currentPage
    this.pages = state.pages
    this.currentRoute = state.route
    this.title = state.title
    this.flashSuccess = state.flashSuccess
    this.flashFailure = state.flashFailure
    this.instagram_client_id = state.instagram_client_id
    this.autocomplete = state.autocomplete
  }
})


module.exports = ApplicationStore
