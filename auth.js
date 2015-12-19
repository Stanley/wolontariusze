var passport = require('passport')
var LocalStrategy = require('passport-local').Strategy
var bcrypt = require('bcrypt')

var config = require('./config.json')
var Volonteer = require('./app/services/'+config.service+'/volonteers')

/**
 * LocalStrategy
 *
 * This strategy is used to authenticate users based on a username and password.
 * Anytime a request is made to authorize an application, we must ensure that
 * a user is logged in before asking them to approve the request.
 */
passport.use(new LocalStrategy(
  function(username, password, done) {
    // Próba logowania
    Volonteer.read({force_admin: true}, 'Volonteers', { key: username }, { index: 'email' }, function (err, users) {
      // Wystąpił niespodziewany błąd
      if (err) { return done(err) }
      var user = users[0]
      // Nie znaleziono użytkownika o danym loginie
      if (!user) {
        return done(null, false, { message: 'Incorrect username.' })
      }
      // Sprawdź poprawność hasła
      if(config.service == 'rethinkdb') {
        bcrypt.compare(password, user.password, function(err, res) {
            if (!res) {
            return done(null, false, { message: 'Incorrect password.' })
            } else if (!user.approved) {
            return done(null, false, { message: 'You have been banned.' })
            } else {
            // Zalogowano poprawnie, zwróć obiekt zalogowanego użytkownika
            return done(null, user, { message: 'Welcome!' })
            }
        })
      } else {
          if (password != user.password) {
              return done(null, false, { message: 'Incorrect password.' })
          } else if (!user.approved) {
            return done(null, false, { message: 'You have been banned.' })
          } else {
            // Zalogowano poprawnie, zwróć obiekt zalogowanego użytkownika
            return done(null, user, { message: 'Welcome!' })
          }
      }
    })
  }
))

// Zdefiniuj metodę przechowywania referencji do obiektu zalogowanego
// użytkownika. Ta zmienna będę skojarzona z sesją użytkownika i przechowywana
// w pamięci serwera.
passport.serializeUser(function(user, done) {
  done(null, user.id)
})

// Zdefiniuj metodę odtworzenia obiektu użytkownika na podstawie wcześniej
// zapamiętanej referencji (numeru id w bazie danych).
passport.deserializeUser(function(id, done) {
  Volonteer.read({force_admin: true}, 'Volonteers', { id: id }, {}, function (err, user) {
    done(err, user)
  })
})
