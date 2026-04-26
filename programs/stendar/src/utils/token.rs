use anchor_spl::token::spl_token;

pub fn is_native_mint(mint: &anchor_lang::prelude::Pubkey) -> bool {
    mint == &spl_token::native_mint::ID
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_spl::token::spl_token::native_mint;

    #[test]
    fn native_mint_detection_matches_spl_native_mint() {
        assert!(is_native_mint(&native_mint::ID));
        assert!(!is_native_mint(&anchor_lang::prelude::Pubkey::new_unique()));
    }
}
